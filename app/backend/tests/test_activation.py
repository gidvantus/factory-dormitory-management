"""Активация кабинета по ссылке из письма."""

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.consent import CONSENT_DOCUMENT_CODE, TERMS_DOCUMENT_CODE
from app.models.activation import ActivationToken
from app.models.document import Document
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
CONSENT_REQUIRED_DETAIL = "Отметьте согласие на обработку персональных данных"
TERMS_REQUIRED_DETAIL = "Отметьте принятие правил использования платформой"


def as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: сравнивать его с aware нельзя."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def activate_body(token: str, password: str = NEW_PASSWORD) -> dict[str, object]:
    """Тело `POST /api/auth/activate` с обеими отмеченными галочками.

    Пользователи этого файла созданы прямо в базе (`create_user`), то есть ни
    согласия, ни правил не принимали, а без них сервер отвечает 422. Сценарии
    отказа строят тело без нужной отметки явно — см. блоки про согласие и
    правила в конце файла.
    """
    return {"token": token, "password": password, "consent": True, "terms_accepted": True}


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
    # Согласия у пользователя нет: экран активации обязан показать чекбокс.
    assert body["consent_required"] is True
    # Правил он тоже не принимал — второй чекбокс показывается по своей колонке.
    assert body["terms_required"] is True


def test_read_activation_of_unknown_token_returns_410(client: TestClient) -> None:
    response = client.get("/api/auth/activate/unknown-token-value")

    assert response.status_code == 410
    assert response.json()["detail"] == "Ссылка активации не найдена"


def test_read_activation_of_used_token_returns_410(client: TestClient, db_session: Session) -> None:
    _, _, raw_token = inactive_user_with_token(db_session)
    activated = client.post("/api/auth/activate", json=activate_body(raw_token))
    assert activated.status_code == 200

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

    response = client.post("/api/auth/activate", json=activate_body(raw_token, "short"))

    assert response.status_code == 422


def test_activate_sets_password_activates_and_opens_session(
    client: TestClient, db_session: Session
) -> None:
    user, record, raw_token = inactive_user_with_token(db_session)
    old_hash = user.password_hash

    response = client.post("/api/auth/activate", json=activate_body(raw_token))

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
    activated = client.post("/api/auth/activate", json=activate_body(raw_token))
    assert activated.status_code == 200

    second = client.post("/api/auth/activate", json=activate_body(raw_token, "another-password-1"))

    assert second.status_code == 410
    assert second.json()["detail"] == "Ссылка активации уже использована"

    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    assert verify_password(NEW_PASSWORD, stored.password_hash) is True
    assert verify_password("another-password-1", stored.password_hash) is False


def test_activate_with_unknown_token_returns_410(client: TestClient) -> None:
    response = client.post("/api/auth/activate", json=activate_body("no-such-token"))

    assert response.status_code == 410
    assert response.json()["detail"] == "Ссылка активации не найдена"


def test_new_password_replaces_the_old_one_for_login(
    client: TestClient, db_session: Session
) -> None:
    user, _, raw_token = inactive_user_with_token(db_session)
    user.password_hash = hash_password(OLD_PASSWORD)
    db_session.commit()

    activated = client.post("/api/auth/activate", json=activate_body(raw_token))
    assert activated.status_code == 200
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


# --- Согласие на обработку персональных данных (issue #67) -------------------
#
# Приглашённый сотрудник регистрацию не проходит — аккаунт ему заводит владелец,
# поэтому согласие спрашивает именно эта ручка. Проверка живёт на сервере:
# прямой запрос к API без согласия не должен активировать кабинет.


def test_activate_without_consent_returns_422_and_keeps_the_token_alive(
    client: TestClient, db_session: Session
) -> None:
    user, record, raw_token = inactive_user_with_token(db_session)

    response = client.post(
        "/api/auth/activate", json={"token": raw_token, "password": NEW_PASSWORD}
    )

    assert response.status_code == 422
    assert response.json()["detail"] == CONSENT_REQUIRED_DETAIL

    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    assert stored.is_active is False
    assert stored.consent_at is None
    # Ссылку человек использует повторно: отказ её не гасит.
    assert token_of(db_session, record.id).used_at is None
    assert client.get(f"/api/auth/activate/{raw_token}").status_code == 200


def test_activate_with_consent_false_returns_422(client: TestClient, db_session: Session) -> None:
    _, record, raw_token = inactive_user_with_token(db_session)

    response = client.post(
        "/api/auth/activate",
        json={"token": raw_token, "password": NEW_PASSWORD, "consent": False},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == CONSENT_REQUIRED_DETAIL
    assert token_of(db_session, record.id).used_at is None


def test_activate_with_consent_records_it_with_the_document_revision(
    client: TestClient, db_session: Session
) -> None:
    user, _, raw_token = inactive_user_with_token(db_session)
    document = Document(
        code=CONSENT_DOCUMENT_CODE,
        title="Согласие на обработку персональных данных",
        body="Текст заготовки.",
        position=3,
    )
    db_session.add(document)
    db_session.commit()
    db_session.refresh(document)
    before = datetime.now(UTC)

    response = client.post("/api/auth/activate", json=activate_body(raw_token))

    assert response.status_code == 200, response.text
    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    assert stored.is_active is True
    assert stored.consent_at is not None
    assert abs(as_utc(stored.consent_at) - before) < timedelta(minutes=1)
    assert stored.consent_document_code == CONSENT_DOCUMENT_CODE
    assert stored.consent_document_updated_at is not None
    assert as_utc(stored.consent_document_updated_at) == as_utc(document.updated_at)


def test_read_activation_reports_consent_no_longer_required(
    client: TestClient, db_session: Session
) -> None:
    """После активации с согласием повторная ссылка чекбокса не показывает."""
    user, _, raw_token = inactive_user_with_token(db_session)
    assert client.post("/api/auth/activate", json=activate_body(raw_token)).status_code == 200

    next_token = issue_activation_token(db_session, user.id)
    db_session.commit()

    body = client.get(f"/api/auth/activate/{next_token}").json()

    assert body["consent_required"] is False
    assert body["terms_required"] is False


def test_second_activation_does_not_overwrite_the_recorded_consent(
    client: TestClient, db_session: Session
) -> None:
    user, _, first_token = inactive_user_with_token(db_session)
    assert client.post("/api/auth/activate", json=activate_body(first_token)).status_code == 200

    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    moment = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    stored.consent_at = moment
    stored.consent_document_code = CONSENT_DOCUMENT_CODE
    stored.consent_document_updated_at = None
    db_session.commit()

    second_token = issue_activation_token(db_session, user.id)
    db_session.commit()
    # Согласие уже записано, поэтому его отсутствие в теле — не отказ.
    second = client.post(
        "/api/auth/activate", json={"token": second_token, "password": "another-password-1"}
    )

    assert second.status_code == 200, second.text
    db_session.expire_all()
    after = db_session.get(User, user.id)
    assert after is not None
    assert after.consent_at is not None
    assert as_utc(after.consent_at) == moment
    assert after.consent_document_code == CONSENT_DOCUMENT_CODE
    assert after.consent_document_updated_at is None


# --- Принятие правил использования платформой (issue #84) --------------------
#
# Правила — второй документ. Приглашённый сотрудник не принимал ни его, ни
# согласие: аккаунт ему заводит владелец. Проверки согласия и правил независимы и
# смотрят каждая в свою колонку — человек, принявший только один документ, должен
# получить требование по второму, а не по обоим сразу.


def test_activate_without_terms_returns_422_and_keeps_the_token_alive(
    client: TestClient, db_session: Session
) -> None:
    """Согласие отмечено, правила — нет: 422 с текстом правил, токен жив."""
    user, record, raw_token = inactive_user_with_token(db_session)

    response = client.post(
        "/api/auth/activate",
        json={"token": raw_token, "password": NEW_PASSWORD, "consent": True},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == TERMS_REQUIRED_DETAIL

    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    assert stored.is_active is False
    assert stored.terms_accepted_at is None
    # Пароль не изменён: проверки стоят до правок пользователя.
    assert stored.password_hash == user.password_hash
    # Ссылку человек использует повторно: отказ её не гасит.
    assert token_of(db_session, record.id).used_at is None
    assert client.get(f"/api/auth/activate/{raw_token}").status_code == 200


def test_activate_with_terms_false_returns_422(client: TestClient, db_session: Session) -> None:
    _, record, raw_token = inactive_user_with_token(db_session)

    response = client.post(
        "/api/auth/activate",
        json={
            "token": raw_token,
            "password": NEW_PASSWORD,
            "consent": True,
            "terms_accepted": False,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == TERMS_REQUIRED_DETAIL
    assert token_of(db_session, record.id).used_at is None


def test_activate_with_terms_records_them_with_the_document_revision(
    client: TestClient, db_session: Session
) -> None:
    user, _, raw_token = inactive_user_with_token(db_session)
    document = Document(
        code=TERMS_DOCUMENT_CODE,
        title="Правила использования платформой",
        body="Текст заготовки.",
        position=2,
    )
    db_session.add(document)
    db_session.commit()
    db_session.refresh(document)
    before = datetime.now(UTC)

    response = client.post("/api/auth/activate", json=activate_body(raw_token))

    assert response.status_code == 200, response.text
    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    assert stored.terms_accepted_at is not None
    assert abs(as_utc(stored.terms_accepted_at) - before) < timedelta(minutes=1)
    assert stored.terms_document_code == TERMS_DOCUMENT_CODE
    assert stored.terms_document_updated_at is not None
    assert as_utc(stored.terms_document_updated_at) == as_utc(document.updated_at)


def test_second_activation_does_not_overwrite_the_recorded_terms(
    client: TestClient, db_session: Session
) -> None:
    user, _, first_token = inactive_user_with_token(db_session)
    assert client.post("/api/auth/activate", json=activate_body(first_token)).status_code == 200

    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    moment = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    stored.terms_accepted_at = moment
    stored.terms_document_code = TERMS_DOCUMENT_CODE
    stored.terms_document_updated_at = None
    db_session.commit()

    second_token = issue_activation_token(db_session, user.id)
    db_session.commit()
    # Правила уже приняты, поэтому их отсутствие в теле — не отказ.
    second = client.post(
        "/api/auth/activate", json={"token": second_token, "password": "another-password-1"}
    )

    assert second.status_code == 200, second.text
    db_session.expire_all()
    after = db_session.get(User, user.id)
    assert after is not None
    assert after.terms_accepted_at is not None
    assert as_utc(after.terms_accepted_at) == moment
    assert after.terms_document_code == TERMS_DOCUMENT_CODE
    assert after.terms_document_updated_at is None


def test_activate_demands_consent_when_only_terms_are_accepted(
    client: TestClient, db_session: Session
) -> None:
    """Правила приняты, согласия нет — требуем согласие, а не правила."""
    user, record, raw_token = inactive_user_with_token(db_session)
    user.terms_accepted_at = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    user.terms_document_code = TERMS_DOCUMENT_CODE
    db_session.commit()

    response = client.post(
        "/api/auth/activate",
        json={"token": raw_token, "password": NEW_PASSWORD, "terms_accepted": True},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == CONSENT_REQUIRED_DETAIL
    assert token_of(db_session, record.id).used_at is None


def test_read_activation_reports_terms_required_from_its_own_column(
    client: TestClient, db_session: Session
) -> None:
    """Согласие есть, правил нет — флаги расходятся по своим колонкам."""
    user, _, raw_token = inactive_user_with_token(db_session)
    user.consent_at = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    user.consent_document_code = CONSENT_DOCUMENT_CODE
    db_session.commit()

    body = client.get(f"/api/auth/activate/{raw_token}").json()

    assert body["consent_required"] is False
    assert body["terms_required"] is True
