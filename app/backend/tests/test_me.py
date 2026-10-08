"""Личный кабинет: GET /api/me."""

from datetime import UTC, datetime, timedelta

import jwt
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.config import get_settings
from tests.conftest import TEST_PASSWORD, create_user, login


def test_me_without_cookie_returns_401(client: TestClient) -> None:
    response = client.get("/api/me")
    assert response.status_code == 401


def test_me_with_cookie_returns_email_and_full_name(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, full_name="Петров Пётр Петрович")
    assert login(client, user.email).status_code == 200

    response = client.get("/api/me")

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == user.email
    assert body["full_name"] == "Петров Пётр Петрович"
    assert body["created_at"]
    assert body["is_active"] is True


def test_me_does_not_return_the_password(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session)
    assert login(client, user.email).status_code == 200

    response = client.get("/api/me")

    assert "password" not in response.json()
    assert "password_hash" not in response.json()
    assert TEST_PASSWORD not in response.text
    assert user.password_hash not in response.text


def test_me_of_inactive_user_answers_200_with_false(
    client: TestClient, db_session: Session
) -> None:
    """Неактивный вход разрешён: фронт по этому признаку уводит на активацию."""
    user = create_user(db_session, is_active=False)

    assert login(client, user.email).status_code == 200
    response = client.get("/api/me")

    assert response.status_code == 200
    assert response.json()["is_active"] is False


def test_me_rejects_token_signed_with_another_secret(client: TestClient) -> None:
    settings = get_settings()
    foreign = jwt.encode({"sub": "1"}, "another-secret-value-0123456789-abcdef", algorithm="HS256")
    client.cookies.set(settings.session_cookie_name, foreign)

    assert client.get("/api/me").status_code == 401


def test_me_rejects_expired_token(client: TestClient) -> None:
    settings = get_settings()
    expired = jwt.encode(
        {"sub": "1", "exp": datetime.now(UTC) - timedelta(seconds=1)},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
    client.cookies.set(settings.session_cookie_name, expired)

    assert client.get("/api/me").status_code == 401


def test_me_rejects_token_of_unknown_user(client: TestClient) -> None:
    settings = get_settings()
    unknown = jwt.encode({"sub": "999"}, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    client.cookies.set(settings.session_cookie_name, unknown)

    assert client.get("/api/me").status_code == 401
