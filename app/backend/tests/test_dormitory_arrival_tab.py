"""Связанная подвкладка: актуальные люди, даты, статусы, перенос и своя область."""

from datetime import date
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTabEntry
from app.models.organization import OrganizationMember
from app.models.role_permission import RolePermission
from tests.conftest import sign_in
from tests.test_arrival_fields import API, body
from tests.test_arrival_workflow import marked, url
from tests.test_custom_tab_options import configure, create
from tests.test_reports import create_dormitory


def test_live_tab_follows_status_date_and_extra_fields_without_copying(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.dormitory_arrivals.today", lambda: date(2026, 11, 10))
    user = sign_in(client, db_session)
    dorm = create_dormitory(client)
    other = create_dormitory(client, name="Другой дом")
    tab = create(client, dorm, data_source="arrival_plan", period_mode="month")
    mapping = tab["options"]["arrival_columns"]
    base = f"/api/dormitories/{dorm}/tabs/{tab['id']}"
    query = "?from=2026-11-01&to=2026-11-30"
    names = next(key for key, value in mapping.items() if value == "full_name")
    status = next(key for key, value in mapping.items() if value == "status")
    plan_body = {**body(dorm), "date": "2026-11-15"}
    plan_body["people"][0]["full_name"] = "Петров Пётр"
    plan = client.post(API, json=plan_body).json()
    assert "id" in plan, plan
    assert client.post(API, json={**body(other), "date": "2026-11-11"}).status_code == 201
    # Настройка дополнительных столбцов через существующий конструктор.
    column = client.post(
        f"/api/dormitories/{dorm}/tables/{tab['table_key']}/columns",
        json={"name": "Смены", "kind": "number"},
    ).json()
    configured = configure(
        client, dorm, tab, arrival_columns={**mapping, str(column["id"]): "person:shifts"}
    )
    assert configured is not None
    rows = client.get(base + "/arrival-rows" + query).json()
    assert len(rows) == 2
    assert rows[1]["custom_values"][names] == "Иванов Иван"
    assert rows[1]["custom_values"][str(column["id"])] == "30"
    assert rows[0]["custom_values"][status] == "Ожидается"
    plan = marked(client, plan, "no_show")
    assert (
        client.get(base + "/arrival-rows" + query).json()[0]["custom_values"][status]
        == "Не приехал"
    )
    moved = client.post(
        url(plan, action="move"), json={"revision": plan["revision"], "date": "2026-11-12"}
    )
    assert moved.status_code == 200, moved.text
    rows = client.get(base + "/arrival-rows" + query).json()
    assert len(rows) == 2
    assert [row["date"] for row in rows] == ["2026-11-12", "2026-11-15"]
    assert rows[0]["custom_values"][status] == "Ожидается"
    assert client.get(base + "/arrival-rows?from=2026-12-01&to=2026-12-31").json() == []
    assert db_session.scalar(select(func.count()).select_from(CustomTabEntry)) == 0
    assert client.post(base + "/rows").status_code == 409
    assert client.post(base + "/clear").status_code == 409
    identity_fields = {"full_name": "Ручная запись"}
    check_token = client.post("/api/personnel/check", json=identity_fields).json()["check_token"]
    assert (
        client.post(
            "/api/personnel/records",
            json={
                "dormitory_id": dorm,
                "table_key": tab["table_key"],
                "identity": {**identity_fields, "mode": "new", "check_token": check_token},
            },
        ).status_code
        == 409
    )
    exchange = f"/api/dormitories/{dorm}/data-transfer/{tab['table_key']}"
    assert client.get(exchange + "/template").status_code == 409
    exported = client.get(exchange + "/export" + query)
    assert exported.status_code == 200, exported.text
    sheet = load_workbook(BytesIO(exported.content)).active
    assert sheet is not None and sheet.max_row == 3
    # Коменданту не нужен доступ к реестру персонала для просмотра своей таблицы.
    member = db_session.scalar(
        select(OrganizationMember).where(OrganizationMember.user_id == user.id)
    )
    assert member is not None
    member.role = "commandant"
    db_session.add(RolePermission(role="commandant", personnel_enabled=False))
    db_session.commit()
    assert client.get(API).status_code == 403
    assert len(client.get(base + "/arrival-rows" + query).json()) == 2
    assert (
        client.get(f"/api/dormitories/{other}/tabs/{tab['id']}/arrival-rows" + query).status_code
        == 404
    )


def test_manual_data_cannot_be_hidden_by_connecting_arrivals(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    tab = create(client, dorm, period_mode="month")
    base = f"/api/dormitories/{dorm}"
    row = client.post(f"{base}/tabs/{tab['id']}/rows").json()
    snapshot = client.get(base + "/settings").json()
    response = client.put(
        base + "/settings",
        json={
            "revision": snapshot["revision"],
            "tabs": [
                {
                    "key": tab["table_key"],
                    "name": tab["name"],
                    "options": {**tab["options"], "data_source": "arrival_plan"},
                }
            ],
        },
    )
    assert response.status_code == 409, response.text
    assert client.get(f"{base}/tabs/{tab['id']}/rows").json()[0]["id"] == row["id"]
