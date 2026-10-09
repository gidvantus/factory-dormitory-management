"""Неактивный аккаунт: кабинет закрыт 403, открыты только /api/me и активация.

Список рабочих ручек не дублируется руками: он берётся из `/openapi.json`,
поэтому новая ручка без `ActiveUser` уронит этот тест.
"""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.security import ACTIVATION_REQUIRED_DETAIL, issue_activation_token
from tests.conftest import create_user, login

# Свободные от guard адреса: вход, регистрация, активация, здоровье и /api/me.
EXEMPT_PREFIXES = ("/api/auth", "/api/health")
EXEMPT_PATHS = frozenset({"/api/me"})

NEW_PASSWORD = "new-password-123"


def is_exempt(path: str) -> bool:
    return path.startswith(EXEMPT_PREFIXES) or path in EXEMPT_PATHS


def working_operations(client: TestClient) -> list[tuple[str, str]]:
    """Все объявленные операции, кроме свободных от guard."""
    paths = client.get("/openapi.json").json()["paths"]
    return [
        (method.upper(), path)
        for path, methods in paths.items()
        if not is_exempt(path)
        for method in methods
    ]


def concrete(path: str) -> str:
    """`/api/dormitories/{dormitory_id}/report` → `/api/dormitories/1/report`."""
    while "{" in path:
        start = path.index("{")
        end = path.index("}", start)
        path = f"{path[:start]}1{path[end + 1 :]}"
    return path


def test_openapi_covers_the_working_surface(client: TestClient) -> None:
    operations = working_operations(client)
    assert len(operations) >= 20
    assert ("GET", "/api/dormitories") in operations
    assert ("GET", "/api/me") not in operations


def test_every_working_operation_documents_403(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()["paths"]

    missing = [
        f"{method.upper()} {path}"
        for path, methods in schema.items()
        if not is_exempt(path)
        for method, operation in methods.items()
        if "403" not in operation["responses"]
    ]

    assert missing == []
    assert "403" not in schema["/api/me"]["get"]["responses"]


def test_inactive_user_gets_403_with_the_activation_hint(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, is_active=False)
    assert login(client, user.email).status_code == 200

    for method, path in working_operations(client):
        response = client.request(method, concrete(path))
        assert response.status_code == 403, f"{method} {path}: {response.status_code}"
        assert response.json()["detail"] == ACTIVATION_REQUIRED_DETAIL, f"{method} {path}"


def test_active_user_passes_the_guard(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session)
    assert login(client, user.email).status_code == 200

    assert client.get("/api/dormitories").status_code == 200
    assert client.get("/api/dashboard?from=2025-09-01&to=2025-09-02").status_code == 200


def test_me_stays_open_for_inactive_user(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, is_active=False, full_name="Неактивный Пользователь")
    assert login(client, user.email).status_code == 200

    response = client.get("/api/me")

    assert response.status_code == 200
    assert response.json() == {
        "email": user.email,
        "full_name": "Неактивный Пользователь",
        "created_at": response.json()["created_at"],
        "is_active": False,
    }


def test_activation_opens_the_working_endpoints(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, is_active=False)
    raw_token = issue_activation_token(db_session, user.id)
    db_session.commit()
    assert login(client, user.email).status_code == 200
    assert client.get("/api/dormitories").status_code == 403

    activated = client.post(
        "/api/auth/activate", json={"token": raw_token, "password": NEW_PASSWORD}
    )

    assert activated.status_code == 200
    assert client.get("/api/dormitories").status_code == 200
