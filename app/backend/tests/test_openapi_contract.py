"""Контракт `/openapi.json`: схема объявляет те статусы, которые роут реально возвращает.

Проверка закрывает регрессию с приёмки: `schemathesis run <стенд>/openapi.json
--checks status_code_conformance` находил необъявленные ответы —
401 у `GET /api/me`, 401 у `POST /api/auth/login`, 409 и 400 у
`POST /api/auth/register`. Роуты отвечали верно, но не передавали `responses=`,
поэтому схема неполна.

Тест держит простое правило: если сценарий возвращает код, этот код есть в схеме.
"""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import create_user, login, organizations_for, register_user

PAYLOAD = {"email": "worker@example.com", "full_name": "Иванов Иван Иванович"}

# Тело с корректной ASCII-обвязкой, но недопустимой UTF-8 последовательностью:
# json.loads падает не на JSONDecodeError, а на UnicodeDecodeError, и FastAPI
# отвечает 400 «There was an error parsing the body», а не 422.
BROKEN_JSON_HEADERS = {"Content-Type": "application/json"}
BROKEN_JSON_BODY = b'{"email": "\xff"}'


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


def test_register_broken_json_400_is_documented(client: TestClient) -> None:
    """Тело, которое не декодируется, — это 400 от FastAPI, а не 422 от валидатора."""
    response = client.post(
        "/api/auth/register", content=BROKEN_JSON_BODY, headers=BROKEN_JSON_HEADERS
    )

    assert response.status_code == 400
    assert "400" in documented_statuses(client, "/api/auth/register", "post")


def test_login_broken_json_400_is_documented(client: TestClient) -> None:
    response = client.post("/api/auth/login", content=BROKEN_JSON_BODY, headers=BROKEN_JSON_HEADERS)

    assert response.status_code == 400
    assert "400" in documented_statuses(client, "/api/auth/login", "post")


def test_organization_patch_broken_json_400_is_documented(
    client: TestClient, db_session: Session
) -> None:
    """Та же регрессия, что у `register`/`login`, но у новой ручки организации.

    Schemathesis находил 400 «There was an error parsing the body» на
    `PATCH /api/organization`, которого не было в опубликованной схеме.
    """
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.patch(
        "/api/organization", content=BROKEN_JSON_BODY, headers=BROKEN_JSON_HEADERS
    )

    assert response.status_code == 400
    assert "400" in documented_statuses(client, "/api/organization", "patch")


def test_organization_patch_documents_every_status_it_returns(
    client: TestClient, db_session: Session
) -> None:
    """404 «не привязан», 403 «нельзя править», 409 и 422 — всё в схеме."""
    documented = documented_statuses(client, "/api/organization", "patch")

    assert {"400", "401", "403", "404", "409", "422"} <= documented


def test_organization_get_documents_not_found(
    client: TestClient,
) -> None:
    documented = documented_statuses(client, "/api/organization", "get")

    assert {"401", "403", "404"} <= documented


def test_organization_members_documents_every_status_it_returns(
    client: TestClient,
) -> None:
    """Список участников: 401 без cookie, 403 у неактивного, 404 без организации."""
    documented = documented_statuses(client, "/api/organization/members", "get")

    assert {"401", "403", "404"} <= documented


def test_organization_invitations_documents_every_status_it_returns(
    client: TestClient,
) -> None:
    """201 и всё, что ручка приглашения возвращает по ошибкам."""
    documented = documented_statuses(client, "/api/organization/invitations", "post")

    assert {"201", "400", "401", "403", "404", "409", "422"} <= documented


def test_organization_invitations_broken_json_400_is_documented(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.post(
        "/api/organization/invitations", content=BROKEN_JSON_BODY, headers=BROKEN_JSON_HEADERS
    )

    assert response.status_code == 400
    assert "400" in documented_statuses(client, "/api/organization/invitations", "post")


def test_success_statuses_stay_documented(client: TestClient) -> None:
    assert "201" in documented_statuses(client, "/api/auth/register", "post")
    assert "200" in documented_statuses(client, "/api/auth/login", "post")
    assert "200" in documented_statuses(client, "/api/me", "get")
