"""Регистрация: неактивный аккаунт, захешированный токен и письмо активации."""

import json
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.consent import (
    CONSENT_DOCUMENT_CODE,
    CONSENT_REQUIRED_DETAIL,
    TERMS_DOCUMENT_CODE,
    TERMS_REQUIRED_DETAIL,
)
from app.models.activation import ActivationToken
from app.models.document import Document
from app.models.user import User
from tests.conftest import register_user

PAYLOAD = {
    "email": "worker@example.com",
    "full_name": "Иванов Иван Иванович",
    "consent": True,
    "terms_accepted": True,
}


def as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: сравнивать его с aware нельзя."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def test_health_is_open(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_register_creates_inactive_user(client: TestClient, db_session: Session) -> None:
    response = client.post("/api/auth/register", json=PAYLOAD)

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == PAYLOAD["email"]
    assert body["full_name"] == PAYLOAD["full_name"]
    assert body["created_at"]
    # SMTP в тестах выключен, шаблона в тестовой базе нет — письмо не отправлено.
    assert body["activation_email_sent"] is False

    user = db_session.scalar(select(User).where(User.email == PAYLOAD["email"]))
    assert user is not None
    assert user.full_name == PAYLOAD["full_name"]
    assert user.is_active is False


def test_register_never_returns_the_generated_password(
    client: TestClient, db_session: Session
) -> None:
    body = register_user(client)

    assert "password" not in body

    user = db_session.scalar(select(User).where(User.email == body["email"]))
    assert user is not None
    assert user.password_hash.startswith("$argon2")
    assert user.password_hash not in json.dumps(body)


def test_register_stores_only_the_hash_of_the_activation_token(
    client: TestClient, db_session: Session
) -> None:
    body = register_user(client)
    user = db_session.scalar(select(User).where(User.email == body["email"]))
    assert user is not None
    token = db_session.scalar(select(ActivationToken).where(ActivationToken.user_id == user.id))

    assert token is not None
    assert token.used_at is None
    # SHA-256 в hex: 64 символа. Открытого токена из письма в базе нет.
    assert len(token.token_hash) == 64
    assert set(token.token_hash) <= set("0123456789abcdef")

    expires_in = as_utc(token.expires_at) - datetime.now(UTC)
    ttl = timedelta(hours=get_settings().activation_token_ttl_hours)
    assert abs(expires_in - ttl) < timedelta(minutes=1)


def test_register_does_not_set_session_cookie(client: TestClient) -> None:
    response = client.post("/api/auth/register", json=PAYLOAD)
    assert "set-cookie" not in response.headers


def test_email_is_stored_and_compared_without_case(client: TestClient, db_session: Session) -> None:
    client.post(
        "/api/auth/register",
        json={
            "email": "Ivan@Example.com",
            "full_name": "Иванов И.",
            "consent": True,
            "terms_accepted": True,
        },
    )

    user = db_session.scalar(select(User).where(User.email == "ivan@example.com"))
    assert user is not None

    duplicate = client.post(
        "/api/auth/register",
        json={
            "email": "IVAN@EXAMPLE.COM",
            "full_name": "Петров Пётр",
            "consent": True,
            "terms_accepted": True,
        },
    )
    assert duplicate.status_code == 409


def test_duplicate_email_returns_409(client: TestClient) -> None:
    register_user(client)

    response = client.post(
        "/api/auth/register",
        json={
            "email": "worker@example.com",
            "full_name": "Петров Пётр Петрович",
            "consent": True,
            "terms_accepted": True,
        },
    )

    assert response.status_code == 409
    assert "password" not in response.json()


def test_invalid_email_returns_422(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": "не-почта",
            "full_name": "Иванов И.",
            "consent": True,
            "terms_accepted": True,
        },
    )
    assert response.status_code == 422


def test_empty_full_name_returns_422(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": "worker@example.com",
            "full_name": "   ",
            "consent": True,
            "terms_accepted": True,
        },
    )
    assert response.status_code == 422


def test_full_name_is_normalized(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": "worker@example.com",
            "full_name": "  Иванов   Иван  ",
            "consent": True,
            "terms_accepted": True,
        },
    )
    assert response.status_code == 201
    assert response.json()["full_name"] == "Иванов Иван"


# --- Согласие на обработку персональных данных (issue #67) -------------------
#
# Согласие требует сервер, а не только форма: иначе регистрацию без согласия
# можно было бы провести прямым запросом к API.


def test_register_without_consent_returns_422(client: TestClient, db_session: Session) -> None:
    response = client.post(
        "/api/auth/register",
        json={"email": "worker@example.com", "full_name": "Иванов Иван Иванович"},
    )

    assert response.status_code == 422
    assert CONSENT_REQUIRED_DETAIL in response.text
    # Пользователь не создан: отказ не должен оставлять полуготовую строку.
    assert db_session.scalar(select(User).where(User.email == "worker@example.com")) is None


def test_register_with_consent_false_returns_422(client: TestClient, db_session: Session) -> None:
    response = client.post(
        "/api/auth/register",
        json={"email": "worker@example.com", "full_name": "Иванов Иван Иванович", "consent": False},
    )

    assert response.status_code == 422
    assert CONSENT_REQUIRED_DETAIL in response.text
    assert db_session.scalar(select(User).where(User.email == "worker@example.com")) is None


def test_register_with_a_quoted_false_consent_returns_422(
    client: TestClient, db_session: Session
) -> None:
    """Строка «false» — тоже отказ: pydantic приводит её к `False`, согласие не пишется.

    Правила здесь отмечены: без этого отказ пришёл бы по второй, не отмеченной
    галочке, и тест проверял бы не приведение типа согласия.
    """
    response = client.post(
        "/api/auth/register",
        json={
            "email": "worker@example.com",
            "full_name": "Иванов Иван Иванович",
            "consent": "false",
            "terms_accepted": True,
        },
    )

    assert response.status_code == 422
    assert CONSENT_REQUIRED_DETAIL in response.text
    assert db_session.scalar(select(User).where(User.email == "worker@example.com")) is None


def test_register_records_consent_with_the_document_revision(
    client: TestClient, db_session: Session
) -> None:
    """Успешная регистрация пишет момент, код документа и снимок его редакции."""
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

    assert client.post("/api/auth/register", json=PAYLOAD).status_code == 201

    user = db_session.scalar(select(User).where(User.email == PAYLOAD["email"]))
    assert user is not None
    assert user.consent_at is not None
    assert abs(as_utc(user.consent_at) - before) < timedelta(minutes=1)
    assert user.consent_document_code == CONSENT_DOCUMENT_CODE
    assert user.consent_document_updated_at is not None
    assert as_utc(user.consent_document_updated_at) == as_utc(document.updated_at)


def test_register_without_the_consent_document_still_succeeds(
    client: TestClient, db_session: Session
) -> None:
    """Нет строки документа — согласие всё равно записано, редакция остаётся пустой.

    Справочник документов не должен превращаться в зависимость регистрации:
    код документа и момент согласия важнее снимка редакции.
    """
    assert client.post("/api/auth/register", json=PAYLOAD).status_code == 201

    user = db_session.scalar(select(User).where(User.email == PAYLOAD["email"]))
    assert user is not None
    assert user.consent_at is not None
    assert user.consent_document_code == CONSENT_DOCUMENT_CODE
    assert user.consent_document_updated_at is None


# --- Принятие правил использования платформой (issue #84) --------------------
#
# Правила — второй документ, отдельный от согласия на обработку данных. Сервер
# требует обе отметки, и отказ по правилам отличается текстом: человек должен
# знать, какую именно галочку поставить. Проверка живёт на сервере, а не только
# в форме, иначе регистрацию без принятия правил можно было бы провести прямым
# запросом к API.


def test_register_without_terms_returns_422(client: TestClient, db_session: Session) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": "worker@example.com",
            "full_name": "Иванов Иван Иванович",
            "consent": True,
        },
    )

    assert response.status_code == 422
    assert TERMS_REQUIRED_DETAIL in response.text
    # Пользователь не создан: отказ не должен оставлять полуготовую строку.
    assert db_session.scalar(select(User).where(User.email == "worker@example.com")) is None


def test_register_with_terms_false_returns_422(client: TestClient, db_session: Session) -> None:
    response = client.post(
        "/api/auth/register",
        json={
            "email": "worker@example.com",
            "full_name": "Иванов Иван Иванович",
            "consent": True,
            "terms_accepted": False,
        },
    )

    assert response.status_code == 422
    assert TERMS_REQUIRED_DETAIL in response.text
    assert db_session.scalar(select(User).where(User.email == "worker@example.com")) is None


def test_register_with_a_quoted_false_terms_returns_422(
    client: TestClient, db_session: Session
) -> None:
    """Строка «false» — тоже отказ: pydantic приводит её к `False`, правила не пишутся."""
    response = client.post(
        "/api/auth/register",
        json={
            "email": "worker@example.com",
            "full_name": "Иванов Иван Иванович",
            "consent": True,
            "terms_accepted": "false",
        },
    )

    assert response.status_code == 422
    assert TERMS_REQUIRED_DETAIL in response.text
    assert db_session.scalar(select(User).where(User.email == "worker@example.com")) is None


def test_register_records_consent_and_terms_with_their_own_document_revisions(
    client: TestClient, db_session: Session
) -> None:
    """Успешная регистрация пишет обе пары, каждую — со снимком своего документа.

    Даты редакции у документов намеренно разные: если бы код брал одну редакцию
    на обе пары, равенство с чужим документом это бы поймало.
    """
    consent_document = Document(
        code=CONSENT_DOCUMENT_CODE,
        title="Согласие на обработку персональных данных",
        body="Текст заготовки.",
        position=3,
        updated_at=datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC),
    )
    terms_document = Document(
        code=TERMS_DOCUMENT_CODE,
        title="Правила использования платформой",
        body="Текст заготовки.",
        position=2,
        updated_at=datetime(2026, 2, 3, 4, 5, 6, tzinfo=UTC),
    )
    db_session.add_all([consent_document, terms_document])
    db_session.commit()
    before = datetime.now(UTC)

    assert client.post("/api/auth/register", json=PAYLOAD).status_code == 201

    user = db_session.scalar(select(User).where(User.email == PAYLOAD["email"]))
    assert user is not None
    for moment in (user.consent_at, user.terms_accepted_at):
        assert moment is not None
        assert abs(as_utc(moment) - before) < timedelta(minutes=1)
    assert user.consent_document_code == CONSENT_DOCUMENT_CODE
    assert user.terms_document_code == TERMS_DOCUMENT_CODE
    assert user.consent_document_updated_at is not None
    assert user.terms_document_updated_at is not None
    assert as_utc(user.consent_document_updated_at) == as_utc(consent_document.updated_at)
    assert as_utc(user.terms_document_updated_at) == as_utc(terms_document.updated_at)


def test_register_without_the_terms_document_still_succeeds(
    client: TestClient, db_session: Session
) -> None:
    """Нет строки документа правил — принятие записано, редакция остаётся пустой.

    Справочник документов не должен превращаться в зависимость регистрации: код
    документа и момент принятия важнее снимка редакции.
    """
    assert client.post("/api/auth/register", json=PAYLOAD).status_code == 201

    user = db_session.scalar(select(User).where(User.email == PAYLOAD["email"]))
    assert user is not None
    assert user.terms_accepted_at is not None
    assert user.terms_document_code == TERMS_DOCUMENT_CODE
    assert user.terms_document_updated_at is None
