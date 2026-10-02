"""Личный кабинет: GET /api/me."""

from datetime import UTC, datetime, timedelta

import jwt
from fastapi.testclient import TestClient

from app.config import get_settings
from tests.conftest import register_user


def test_me_without_cookie_returns_401(client: TestClient) -> None:
    response = client.get("/api/me")
    assert response.status_code == 401


def test_me_with_cookie_returns_email_and_full_name(client: TestClient) -> None:
    body = register_user(client, full_name="Петров Пётр Петрович")
    client.post("/api/auth/login", json={"email": body["email"], "password": body["password"]})

    response = client.get("/api/me")

    assert response.status_code == 200
    assert response.json()["email"] == body["email"]
    assert response.json()["full_name"] == "Петров Пётр Петрович"
    assert response.json()["created_at"]


def test_me_does_not_return_the_password(client: TestClient) -> None:
    body = register_user(client)
    client.post("/api/auth/login", json={"email": body["email"], "password": body["password"]})

    response = client.get("/api/me")

    assert "password" not in response.json()
    assert body["password"] not in response.text


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
