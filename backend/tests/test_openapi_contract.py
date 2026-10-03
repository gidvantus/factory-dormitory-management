"""Контракт `/openapi.json`: схема объявляет те статусы, которые роут реально возвращает.

Проверка закрывает регрессию с приёмки: `schemathesis run <стенд>/openapi.json
--checks status_code_conformance` находил три необъявленных ответа —
401 у `GET /api/me`, 401 у `POST /api/auth/login` и 409 у `POST /api/auth/register`.
Роуты отвечали верно, но не передавали `responses=`, поэтому схема неполна.

Тест держит простое правило: если сценарий возвращает код, этот код есть в схеме.
"""

from fastapi.testclient import TestClient

from tests.conftest import register_user

PAYLOAD = {"email": "worker@example.com", "full_name": "Иванов Иван Иванович"}


def documented_statuses(client: TestClient, path: str, method: str) -> set[str]:
    """Коды ответов, объявленные для операции в опубликованной схеме."""
    schema = client.get("/openapi.json").json()
    return set(schema["paths"][path][method]["responses"])


def test_me_401_is_documented(client: TestClient) -> None:
    response = client.get("/api/me")

    assert response.status_code == 401
    assert "401" in documented_statuses(client, "/api/me", "get")


def test_login_401_is_documented(client: TestClient) -> None:
    register_user(client)

    response = client.post(
        "/api/auth/login", json={"email": PAYLOAD["email"], "password": "неверный-пароль"}
    )

    assert response.status_code == 401
    assert "401" in documented_statuses(client, "/api/auth/login", "post")


def test_register_409_is_documented(client: TestClient) -> None:
    register_user(client)

    response = client.post("/api/auth/register", json=PAYLOAD)

    assert response.status_code == 409
    assert "409" in documented_statuses(client, "/api/auth/register", "post")


def test_success_statuses_stay_documented(client: TestClient) -> None:
    assert "201" in documented_statuses(client, "/api/auth/register", "post")
    assert "200" in documented_statuses(client, "/api/auth/login", "post")
    assert "200" in documented_statuses(client, "/api/me", "get")
