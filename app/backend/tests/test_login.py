"""Вход и выход."""

from fastapi.testclient import TestClient

from app.config import get_settings
from tests.conftest import register_user


def test_login_sets_httponly_cookie(client: TestClient) -> None:
    body = register_user(client)

    response = client.post(
        "/api/auth/login",
        json={"email": body["email"], "password": body["password"]},
    )

    assert response.status_code == 200
    assert response.json()["email"] == body["email"]
    cookie_header = response.headers["set-cookie"]
    assert "HttpOnly" in cookie_header
    assert "SameSite=lax" in cookie_header
    assert get_settings().session_cookie_name in cookie_header


def test_login_accepts_email_in_another_case(client: TestClient) -> None:
    body = register_user(client, email="worker@example.com")

    response = client.post(
        "/api/auth/login",
        json={"email": "WORKER@Example.com", "password": body["password"]},
    )

    assert response.status_code == 200


def test_login_with_wrong_password_returns_401(client: TestClient) -> None:
    register_user(client)

    response = client.post(
        "/api/auth/login",
        json={"email": "worker@example.com", "password": "not-the-password"},
    )

    assert response.status_code == 401
    assert "set-cookie" not in response.headers


def test_login_with_unknown_email_returns_401(client: TestClient) -> None:
    response = client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "whatever-pass"},
    )

    assert response.status_code == 401


def test_failed_login_does_not_reveal_which_part_is_wrong(client: TestClient) -> None:
    register_user(client)
    unknown_email = client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "whatever-pass"},
    )
    wrong_password = client.post(
        "/api/auth/login",
        json={"email": "worker@example.com", "password": "whatever-pass"},
    )

    assert unknown_email.status_code == wrong_password.status_code == 401
    assert unknown_email.json() == wrong_password.json()


def test_logout_removes_access(client: TestClient) -> None:
    body = register_user(client)
    client.post("/api/auth/login", json={"email": body["email"], "password": body["password"]})
    assert client.get("/api/me").status_code == 200

    logout = client.post("/api/auth/logout")

    assert logout.status_code == 204
    assert "HttpOnly" in logout.headers["set-cookie"]
    assert client.get("/api/me").status_code == 401
