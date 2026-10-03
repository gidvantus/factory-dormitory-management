"""Пароли и токены: модуль security."""

from datetime import UTC, datetime, timedelta

import jwt
from fastapi.testclient import TestClient

from app.config import get_settings
from app.security import (
    create_access_token,
    decode_access_token,
    generate_password,
    hash_password,
    verify_password,
)


def test_generated_password_is_long_enough() -> None:
    assert len(generate_password()) >= 12


def test_generated_passwords_differ() -> None:
    assert generate_password() != generate_password()


def test_hash_is_not_the_password() -> None:
    password = generate_password()
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


def test_me_with_broken_cookie_is_unauthorized(client: TestClient) -> None:
    settings = get_settings()
    client.cookies.set(settings.session_cookie_name, "broken-not-a-jwt")
    response = client.get("/api/me")
    assert response.status_code == 401
    assert "broken-not-a-jwt" not in response.text
