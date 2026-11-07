"""Пароли и токены: модуль security."""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.config import get_settings
from app.security import (
    BOT_TOKEN_HEADER,
    IMPERSONATION_CLAIM,
    IMPERSONATION_CLAIM_VALUE,
    INVALID_BOT_TOKEN_DETAIL,
    INVALID_OPERATOR_TOKEN_DETAIL,
    OPERATOR_TOKEN_HEADER,
    create_access_token,
    create_impersonation_token,
    decode_access_token,
    decode_impersonation_token,
    hash_password,
    require_operator_service,
    require_service_bot,
    verify_password,
)

# Заведомо ненастоящие секреты: настоящие в тестах не нужны.
BOT_SERVICE_TOKEN = "unit-test-bot-service-token"
OPERATOR_SERVICE_TOKEN = "unit-test-operator-service-token"


def test_hash_is_not_the_password() -> None:
    password = "correct-horse-battery-staple"
    password_hash = hash_password(password)
    assert password_hash != password
    assert password not in password_hash


def test_verify_accepts_correct_password() -> None:
    password = "correct-horse-battery"
    assert verify_password(password, hash_password(password)) is True


def test_verify_rejects_wrong_password() -> None:
    assert verify_password("wrong-password", hash_password("right-password")) is False


def test_verify_rejects_broken_hash() -> None:
    # Испорченный хеш не должен превращаться в 500.
    assert verify_password("any", "не-хеш") is False


def test_token_roundtrip() -> None:
    payload = decode_access_token(create_access_token("42"))
    assert payload is not None
    assert payload["sub"] == "42"


def test_token_signed_with_another_secret_is_rejected() -> None:
    foreign = jwt.encode({"sub": "1"}, "another-secret-value-0123456789-abcdef", algorithm="HS256")
    assert decode_access_token(foreign) is None


def test_expired_token_is_rejected() -> None:
    settings = get_settings()
    expired = jwt.encode(
        {"sub": "1", "exp": datetime.now(UTC) - timedelta(seconds=1)},
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
    assert decode_access_token(expired) is None


def test_garbage_token_is_rejected() -> None:
    assert decode_access_token("не.токен") is None


def test_impersonation_token_roundtrip() -> None:
    """Ссылка поддержки несёт id пользователя и живёт секундами, а не днями."""
    token = create_impersonation_token(42)
    payload = decode_access_token(token)

    assert decode_impersonation_token(token) == 42
    assert payload is not None
    assert payload[IMPERSONATION_CLAIM] is IMPERSONATION_CLAIM_VALUE
    assert payload["exp"] - payload["iat"] == get_settings().impersonation_token_ttl_seconds


def test_expired_impersonation_token_is_rejected() -> None:
    """Просроченная ссылка — `None`, а не исключение: решение принимает ручка."""
    expired_after = get_settings().impersonation_token_ttl_seconds + 1
    token = create_impersonation_token(42, now=datetime.now(UTC) - timedelta(seconds=expired_after))

    assert decode_impersonation_token(token) is None


def test_impersonation_token_with_a_foreign_claim_is_rejected() -> None:
    """Признак обязан быть ровно `true`: `"true"` и `false` — это не ссылка."""
    settings = get_settings()
    now = datetime.now(UTC)
    for claim_value in (False, "true", 1, None):
        payload = {
            "sub": "42",
            "iat": now,
            "exp": now + timedelta(seconds=60),
            IMPERSONATION_CLAIM: claim_value,
        }
        token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)

        assert decode_impersonation_token(token) is None


def test_ordinary_session_token_is_not_an_impersonation_token() -> None:
    """Обычный вход признака не несёт, поэтому ссылкой не считается."""
    assert decode_impersonation_token(create_access_token("42")) is None


def test_me_with_broken_cookie_is_unauthorized(client: TestClient) -> None:
    settings = get_settings()
    client.cookies.set(settings.session_cookie_name, "broken-not-a-jwt")
    response = client.get("/api/me")
    assert response.status_code == 401
    assert "broken-not-a-jwt" not in response.text


def header_request(name: str, raw: bytes) -> Request:
    """Запрос с сырыми байтами заголовка — ровно так его отдаёт ASGI-сервер."""
    return Request({"type": "http", "headers": [(name.lower().encode("ascii"), raw)]})


@pytest.fixture
def service_secrets(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Оба сервисных секрета заданы. Кеш настроек сбрасывается до и после."""
    monkeypatch.setenv("TELEGRAM_SERVICE_TOKEN", BOT_SERVICE_TOKEN)
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", OPERATOR_SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


@pytest.mark.parametrize(
    ("header", "guard", "detail"),
    [
        (BOT_TOKEN_HEADER, require_service_bot, INVALID_BOT_TOKEN_DETAIL),
        (OPERATOR_TOKEN_HEADER, require_operator_service, INVALID_OPERATOR_TOKEN_DETAIL),
    ],
)
def test_non_ascii_service_token_is_a_plain_refusal(
    service_secrets: None,
    header: str,
    guard: Callable[[Request], None],
    detail: str,
) -> None:
    """Мусорный заголовок — это неверный токен (`401`), а не `500` с traceback.

    Байт `0xE9` — obs-text: h11 его пропускает, Starlette отдаёт значение
    строкой в latin-1, а `secrets.compare_digest` на не-ASCII `str` бросает
    `TypeError`. Оба сервисных контура обязаны вести себя одинаково.
    """
    request = header_request(header, b"\xe9")

    with pytest.raises(HTTPException) as error:
        guard(request)

    assert error.value.status_code == 401
    assert error.value.detail == detail


@pytest.mark.parametrize(
    ("header", "guard"),
    [
        (BOT_TOKEN_HEADER, require_service_bot),
        (OPERATOR_TOKEN_HEADER, require_operator_service),
    ],
)
def test_correct_service_token_still_passes(
    service_secrets: None,
    header: str,
    guard: Callable[[Request], None],
) -> None:
    """Побайтовое сравнение не сломало штатный пропуск."""
    token = BOT_SERVICE_TOKEN if header == BOT_TOKEN_HEADER else OPERATOR_SERVICE_TOKEN

    guard(header_request(header, token.encode("utf-8")))
