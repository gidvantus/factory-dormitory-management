"""Регистрация."""

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.user import User
from tests.conftest import register_user

PAYLOAD = {"email": "worker@example.com", "full_name": "Иванов Иван Иванович"}


def test_health_is_open(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_register_creates_user_and_returns_password(
    client: TestClient, db_session: Session
) -> None:
    response = client.post("/api/auth/register", json=PAYLOAD)

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == PAYLOAD["email"]
    assert body["full_name"] == PAYLOAD["full_name"]
    assert len(body["password"]) >= 12
    assert body["created_at"]

    user = db_session.scalar(select(User).where(User.email == PAYLOAD["email"]))
    assert user is not None
    assert user.full_name == PAYLOAD["full_name"]
    assert user.is_active is True


def test_password_hash_is_not_the_open_password(client: TestClient, db_session: Session) -> None:
    body = register_user(client)

    user = db_session.scalar(select(User).where(User.email == body["email"]))
    assert user is not None
    assert user.password_hash != body["password"]
    assert body["password"] not in user.password_hash


def test_register_does_not_set_session_cookie(client: TestClient) -> None:
    response = client.post("/api/auth/register", json=PAYLOAD)
    assert "set-cookie" not in response.headers


def test_email_is_stored_and_compared_without_case(client: TestClient, db_session: Session) -> None:
    client.post("/api/auth/register", json={"email": "Ivan@Example.com", "full_name": "Иванов И."})

    user = db_session.scalar(select(User).where(User.email == "ivan@example.com"))
    assert user is not None

    duplicate = client.post(
        "/api/auth/register",
        json={"email": "IVAN@EXAMPLE.COM", "full_name": "Петров Пётр"},
    )
    assert duplicate.status_code == 409


def test_duplicate_email_returns_409(client: TestClient) -> None:
    register_user(client)

    response = client.post(
        "/api/auth/register",
        json={"email": "worker@example.com", "full_name": "Петров Пётр Петрович"},
    )

    assert response.status_code == 409
    assert "password" not in response.json()


def test_invalid_email_returns_422(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register", json={"email": "не-почта", "full_name": "Иванов И."}
    )
    assert response.status_code == 422


def test_empty_full_name_returns_422(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register",
        json={"email": "worker@example.com", "full_name": "   "},
    )
    assert response.status_code == 422


def test_full_name_is_normalized(client: TestClient) -> None:
    response = client.post(
        "/api/auth/register",
        json={"email": "worker@example.com", "full_name": "  Иванов   Иван  "},
    )
    assert response.status_code == 201
    assert response.json()["full_name"] == "Иванов Иван"
