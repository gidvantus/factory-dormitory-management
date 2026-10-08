"""Активация кабинета по ссылке из письма."""

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.activation import ActivationToken
from app.models.user import User
from app.security import (
    hash_activation_token,
    hash_password,
    issue_activation_token,
    verify_password,
)
from tests.conftest import create_user, login

NEW_PASSWORD = "new-password-123"
OLD_PASSWORD = "service-password-1"


def inactive_user_with_token(
    db_session: Session,
    email: str = "inactive@example.com",
) -> tuple[User, ActivationToken, str]:
    """Неактивный пользователь и выпущенная ему ссылка: открытый токен знает тест."""
    user = create_user(db_session, email=email, is_active=False)
    raw_token = issue_activation_token(db_session, user.id)
    db_session.commit()
    record = db_session.scalar(select(ActivationToken).where(ActivationToken.user_id == user.id))
    assert record is not None
    return user, record, raw_token


def token_of(db_session: Session, token_id: int) -> ActivationToken:
    record = db_session.get(ActivationToken, token_id)
    assert record is not None
    return record


def test_read_activation_returns_email_and_full_name(
    client: TestClient, db_session: Session
) -> None:
    user, _, raw_token = inactive_user_with_token(db_session)

    response = client.get(f"/api/auth/activate/{raw_token}")

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == user.email
    assert body["full_name"] == user.full_name
    assert body["expires_at"]


def test_read_activation_of_unknown_token_returns_410(client: TestClient) -> None:
    response = client.get("/api/auth/activate/unknown-token-value")

    assert response.status_code == 410
    assert response.json()["detail"] == "Ссылка активации не найдена"


def test_read_activation_of_used_token_returns_410(client: TestClient, db_session: Session) -> None:
    _, _, raw_token = inactive_user_with_token(db_session)
    assert (
        client.post(
            "/api/auth/activate", json={"token": raw_token, "password": NEW_PASSWORD}
        ).status_code
        == 200
    )

    response = client.get(f"/api/auth/activate/{raw_token}")

    assert response.status_code == 410
    assert response.json()["detail"] == "Ссылка активации уже использована"


def test_read_activation_of_expired_token_returns_410(
    client: TestClient, db_session: Session
) -> None:
    _, record, raw_token = inactive_user_with_token(db_session)
    record.expires_at = datetime.now(UTC) - timedelta(hours=1)
    db_session.commit()

    response = client.get(f"/api/auth/activate/{raw_token}")

    assert response.status_code == 410
    assert response.json()["detail"] == "Срок действия ссылки активации истёк"


def test_activate_rejects_short_password(client: TestClient, db_session: Session) -> None:
    _, _, raw_token = inactive_user_with_token(db_session)

    response = client.post("/api/auth/activate", json={"token": raw_token, "password": "short"})

    assert response.status_code == 422


def test_activate_sets_password_activates_and_opens_session(
    client: TestClient, db_session: Session
) -> None:
    user, record, raw_token = inactive_user_with_token(db_session)
    old_hash = user.password_hash

    response = client.post(
        "/api/auth/activate", json={"token": raw_token, "password": NEW_PASSWORD}
    )

    assert response.status_code == 200
    assert response.json()["is_active"] is True
    cookie_header = response.headers["set-cookie"]
    assert get_settings().session_cookie_name in cookie_header
    assert "HttpOnly" in cookie_header

    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    assert stored.is_active is True
    assert stored.password_hash != old_hash
    assert verify_password(NEW_PASSWORD, stored.password_hash) is True

    assert token_of(db_session, record.id).used_at is not None


def test_activated_token_is_single_use(client: TestClient, db_session: Session) -> None:
    user, _, raw_token = inactive_user_with_token(db_session)
    assert (
        client.post(
            "/api/auth/activate", json={"token": raw_token, "password": NEW_PASSWORD}
        ).status_code
        == 200
    )

    second = client.post(
        "/api/auth/activate", json={"token": raw_token, "password": "another-password-1"}
    )

    assert second.status_code == 410
    assert second.json()["detail"] == "Ссылка активации уже использована"

    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    assert verify_password(NEW_PASSWORD, stored.password_hash) is True
    assert verify_password("another-password-1", stored.password_hash) is False


def test_activate_with_unknown_token_returns_410(client: TestClient) -> None:
    response = client.post(
        "/api/auth/activate", json={"token": "no-such-token", "password": NEW_PASSWORD}
    )

    assert response.status_code == 410
    assert response.json()["detail"] == "Ссылка активации не найдена"


def test_new_password_replaces_the_old_one_for_login(
    client: TestClient, db_session: Session
) -> None:
    user, _, raw_token = inactive_user_with_token(db_session)
    user.password_hash = hash_password(OLD_PASSWORD)
    db_session.commit()

    assert (
        client.post(
            "/api/auth/activate", json={"token": raw_token, "password": NEW_PASSWORD}
        ).status_code
        == 200
    )
    assert client.post("/api/auth/logout").status_code == 204

    assert login(client, user.email, NEW_PASSWORD).status_code == 200
    assert client.post("/api/auth/logout").status_code == 204
    assert login(client, user.email, OLD_PASSWORD).status_code == 401


def test_resend_marks_old_tokens_and_issues_a_new_one(
    client: TestClient, db_session: Session
) -> None:
    user, old_record, old_token = inactive_user_with_token(db_session)

    response = client.post("/api/auth/activate/resend", json={"email": user.email})

    assert response.status_code == 200
    assert client.get(f"/api/auth/activate/{old_token}").status_code == 410

    db_session.expire_all()
    assert token_of(db_session, old_record.id).used_at is not None
    tokens = list(
        db_session.scalars(select(ActivationToken).where(ActivationToken.user_id == user.id))
    )
    assert len(tokens) == 2
    assert len([token for token in tokens if token.used_at is None]) == 1


def test_resend_issues_an_activation_kind_token(client: TestClient, db_session: Session) -> None:
    """Повторная отправка помечает ссылку как письмо активации, а не восстановления."""
    user = create_user(db_session, email="inactive@example.com", is_active=False)

    assert client.post("/api/auth/activate/resend", json={"email": user.email}).status_code == 200

    record = db_session.scalar(select(ActivationToken).where(ActivationToken.user_id == user.id))
    assert record is not None
    assert record.kind == "activation"


def test_resend_answers_the_same_for_known_and_unknown_email(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="known@example.com", is_active=False)

    known = client.post("/api/auth/activate/resend", json={"email": user.email})
    unknown = client.post("/api/auth/activate/resend", json={"email": "nobody@example.com"})

    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()


def test_resend_does_nothing_for_an_active_user(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, email="active@example.com", is_active=True)

    response = client.post("/api/auth/activate/resend", json={"email": user.email})

    assert response.status_code == 200
    assert list(db_session.scalars(select(ActivationToken))) == []


def test_tokens_are_stored_as_hashes(client: TestClient, db_session: Session) -> None:
    _, _, raw_token = inactive_user_with_token(db_session)

    hashes = [token.token_hash for token in db_session.scalars(select(ActivationToken))]
    assert raw_token not in hashes
    assert hash_activation_token(raw_token) in hashes
