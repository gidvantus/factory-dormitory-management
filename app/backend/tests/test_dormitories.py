"""Создание, сохранение и общий доступ к общежитиям."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.user import User
from app.report_defaults import REQUIRED_REPORT_ROW_NAMES
from tests.conftest import sign_in

PAYLOAD = {"name": "Северное", "client_name": "Стройкомплект"}


def test_dormitories_require_authentication(client: TestClient) -> None:
    assert client.get("/api/dormitories").status_code == 401
    assert client.post("/api/dormitories", json=PAYLOAD).status_code == 401
    assert client.get("/api/dormitories/1").status_code == 401
    assert client.patch("/api/dormitories/1", json={"is_archived": True}).status_code == 401


def test_create_persists_and_returns_list_and_details(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session, email="creator@example.com")
    assert client.get("/api/dormitories").json() == []
    response = client.post("/api/dormitories", json=PAYLOAD)
    assert response.status_code == 201
    created = response.json()
    assert created["name"] == PAYLOAD["name"]
    assert created["client_name"] == PAYLOAD["client_name"]
    assert created["is_archived"] is False
    assert created["created_at"]
    row = db_session.get(Dormitory, created["id"])
    assert row is not None
    assert row.created_by_id == db_session.scalar(
        select(User.id).where(User.email == "creator@example.com")
    )
    db_session.expire_all()
    assert client.get("/api/dormitories").json() == [created]
    assert client.get(f"/api/dormitories/{created['id']}").json() == created
    report = client.get(
        f"/api/dormitories/{created['id']}/report?from=2026-10-01&to=2026-10-01"
    ).json()
    assert [row["name"] for row in report["rows"]] == list(REQUIRED_REPORT_ROW_NAMES)
    assert [row["formula"] for row in report["rows"]] == ["=0", "=0", "=0"]


def test_all_authenticated_users_share_dormitories(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session, email="creator@example.com")
    first = client.post("/api/dormitories", json=PAYLOAD).json()
    client.post("/api/auth/logout")
    sign_in(client, db_session, email="colleague@example.com")
    assert client.get("/api/dormitories").json() == [first]
    assert client.get(f"/api/dormitories/{first['id']}").json() == first
    second = client.post(
        "/api/dormitories", json={"name": "Южное", "client_name": "Другой клиент"}
    ).json()
    assert client.get("/api/dormitories").json() == [second, first]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"name": "Северное"},
        {"name": "", "client_name": "Клиент"},
        {"name": " \t\n ", "client_name": "Клиент"},
        {"name": "Северное", "client_name": " \n "},
        {"name": "Северное", "client_name": "x" * 256},
        {"name": "x" * 256, "client_name": "Клиент"},
        {"name": 123, "client_name": "Клиент"},
        {"name": "Северное\x00", "client_name": "Клиент"},
        {**PAYLOAD, "created_by_id": 999},
    ],
)
def test_invalid_fields_do_not_create_rows(
    client: TestClient, db_session: Session, payload: dict[str, object]
) -> None:
    sign_in(client, db_session, email="creator@example.com")
    assert client.post("/api/dormitories", json=payload).status_code == 422
    assert db_session.scalar(select(func.count()).select_from(Dormitory)) == 0


def test_names_are_normalized(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session, email="creator@example.com")
    created = client.post(
        "/api/dormitories",
        json={"name": "  Северное   общежитие  ", "client_name": "  ООО  Стройкомплект  "},
    ).json()
    assert created["name"] == "Северное общежитие"
    assert created["client_name"] == "ООО Стройкомплект"


def test_missing_dormitory_and_response_contract(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session, email="creator@example.com")
    assert client.get("/api/dormitories/999").status_code == 404
    assert client.get("/api/dormitories/999999999999999999999").status_code == 422
    schema = client.get("/openapi.json").json()["paths"]
    assert {"200", "401"} <= set(schema["/api/dormitories"]["get"]["responses"])
    assert {"201", "400", "401", "422"} <= set(schema["/api/dormitories"]["post"]["responses"])
    assert {"200", "401", "404", "422"} <= set(
        schema["/api/dormitories/{dormitory_id}"]["get"]["responses"]
    )


def test_rename_archive_and_restore_keep_report_and_identity(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    created = client.post("/api/dormitories", json=PAYLOAD).json()
    other = client.post("/api/dormitories", json={"name": "Южное", "client_name": "Б"}).json()
    base = f"/api/dormitories/{created['id']}"
    report_url = f"{base}/report?from=2026-10-01&to=2026-10-01"
    row = client.post(f"{base}/report/rows", json={"name": "Источник"}).json()
    assert (
        client.put(
            f"{base}/report/rows/{row['id']}/cells/2026-10-01", json={"value": "23"}
        ).status_code
        == 204
    )
    report = client.get(report_url).json()
    renamed = client.patch(
        base, json={"name": " Новое   название ", "client_name": " Новый   клиент "}
    )
    assert renamed.status_code == 200
    assert renamed.json() == {**created, "name": "Новое название", "client_name": "Новый клиент"}
    archived = client.patch(base, json={"is_archived": True})
    assert archived.status_code == 200
    assert archived.json()["is_archived"] is True
    assert client.get(base).json() == archived.json()
    assert archived.json() in client.get("/api/dormitories").json()
    assert client.get(report_url).json() == report
    assert client.get(f"/api/dormitories/{other['id']}").json() == other
    restored = client.patch(base, json={"is_archived": False})
    assert restored.status_code == 200
    assert restored.json() == renamed.json()
    assert client.get(report_url).json() == report
    assert client.patch("/api/dormitories/999999", json={"is_archived": True}).status_code == 404


@pytest.mark.parametrize(
    "changes",
    [
        {"name": "   "},
        {"client_name": None},
        {"name": "x" * 256},
        {"name": "Название\x00"},
        {"is_archived": None},
        {"is_archived": "true"},
        {"is_archived": 1},
        {"created_by_id": 1},
    ],
)
def test_invalid_updates_do_not_change_dormitory(
    client: TestClient, db_session: Session, changes: dict[str, object]
) -> None:
    sign_in(client, db_session)
    created = client.post("/api/dormitories", json=PAYLOAD).json()
    base = f"/api/dormitories/{created['id']}"
    assert client.patch(base, json=changes).status_code == 422
    assert client.get(base).json() == created
