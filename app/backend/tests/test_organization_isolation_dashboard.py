"""Изоляция дашборда по организациям: раскладка, блоки и лимит — свои у каждой.

Проверяется через API двумя кабинетами: `sign_in` заводит пользователю **свою**
организацию, поэтому второй вход — это вторая организация, а не коллега.
"""

from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import report_readiness
from app.models.dashboard_block import DEFAULT_DASHBOARD_ORDER, DashboardBlock
from app.models.dormitory import Dormitory
from app.models.report import ReportRow
from tests.conftest import add_colleague, login, sign_in

PERIOD = "?from=2026-10-01&to=2026-10-02"


@pytest.fixture(autouse=True)
def clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(report_readiness, "today_moscow", lambda: date(2026, 10, 9))
    monkeypatch.setattr("app.api.dashboard_blocks.today_moscow", lambda: date(2026, 10, 9))


def config(dormitory_id: int, row_id: int) -> dict[str, Any]:
    return {
        "name": "Мой блок",
        "display": "number",
        "source_kind": "report",
        "operation": "sum",
        "period": "range",
        "grouping": "dormitory",
        "all_dormitories": False,
        "sources": [{"kind": "report", "dormitory_id": dormitory_id, "row_id": row_id}],
    }


def report_source(db: Session, organization_id: int, name: str) -> tuple[Dormitory, ReportRow]:
    """Общежитие организации с одной строкой отчёта — источник блока."""
    dormitory = Dormitory(name=name, client_name="Клиент", organization_id=organization_id)
    db.add(dormitory)
    db.flush()
    row = ReportRow(dormitory_id=dormitory.id, name="Показатель", position=1)
    db.add(row)
    db.commit()
    return dormitory, row


def test_each_organization_has_its_own_layout_blocks_and_limit(
    client: TestClient, db_session: Session
) -> None:
    first_owner = sign_in(client, db_session, email="first@example.com")
    first_organization = first_owner.active_organization_id
    assert first_organization is not None
    dormitory, row = report_source(db_session, first_organization, "Северное")

    created = client.post(
        "/api/dashboard/blocks", json={"revision": 0, "config": config(dormitory.id, row.id)}
    )
    assert created.status_code == 201, created.text
    first_layout = created.json()
    key = f"custom:{first_layout['blocks'][0]['id']}"
    assert first_layout["order"] == [*DEFAULT_DASHBOARD_ORDER, key]

    second_owner = sign_in(client, db_session, email="second@example.com")
    second_organization = second_owner.active_organization_id
    assert second_organization is not None and second_organization != first_organization
    second_layout = client.get("/api/dashboard/layout").json()
    assert second_layout["blocks"] == []
    assert second_layout["order"] == DEFAULT_DASHBOARD_ORDER
    assert second_layout["revision"] == 0

    order = list(reversed(DEFAULT_DASHBOARD_ORDER))
    moved = client.put(
        "/api/dashboard/layout", json={"revision": 0, "order": order, "hidden": ["reports"]}
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["order"] == order
    assert moved.json()["hidden"] == ["reports"]

    # Обзор второй организации не содержит блока первой.
    dashboard = client.get(f"/api/dashboard{PERIOD}")
    assert dashboard.status_code == 200, dashboard.text
    assert dashboard.json()["widgets"] == []

    # Коллега первой организации видит ту же раскладку: она общая внутри
    # организации, но не между организациями.
    colleague = add_colleague(db_session, first_organization, email="colleague@example.com")
    assert login(client, colleague.email).status_code == 200
    first_again = client.get("/api/dashboard/layout").json()
    assert first_again == first_layout
    assert [block["id"] for block in first_again["blocks"]] == [first_layout["blocks"][0]["id"]]

    stored = list(db_session.scalars(select(DashboardBlock)))
    assert {block.organization_id for block in stored} == {first_organization}


def test_foreign_block_answers_exactly_like_a_missing_one(
    client: TestClient, db_session: Session
) -> None:
    first_owner = sign_in(client, db_session, email="first@example.com")
    first_organization = first_owner.active_organization_id
    assert first_organization is not None
    dormitory, row = report_source(db_session, first_organization, "Северное")
    payload = config(dormitory.id, row.id)
    created = client.post("/api/dashboard/blocks", json={"revision": 0, "config": payload})
    assert created.status_code == 201, created.text
    block_id = created.json()["blocks"][0]["id"]

    sign_in(client, db_session, email="second@example.com")
    revision = client.get("/api/dashboard/layout").json()["revision"]
    missing_id = block_id + 1000

    missing = client.put(
        f"/api/dashboard/blocks/{missing_id}", json={"revision": revision, "config": payload}
    )
    foreign = client.put(
        f"/api/dashboard/blocks/{block_id}", json={"revision": revision, "config": payload}
    )
    assert missing.status_code == foreign.status_code == 404
    assert foreign.json() == missing.json() == {"detail": "Блок не найден"}

    deleted_missing = client.delete(f"/api/dashboard/blocks/{missing_id}?revision={revision}")
    deleted_foreign = client.delete(f"/api/dashboard/blocks/{block_id}?revision={revision}")
    assert deleted_missing.status_code == deleted_foreign.status_code == 404
    assert deleted_foreign.json() == deleted_missing.json()

    # Неудачные попытки ничего не изменили: блок на месте и у своей организации.
    stored = db_session.get(DashboardBlock, block_id)
    assert stored is not None
    assert stored.organization_id == first_organization


def test_block_limit_is_counted_inside_the_organization(
    client: TestClient, db_session: Session
) -> None:
    first_owner = sign_in(client, db_session, email="first@example.com")
    first_organization = first_owner.active_organization_id
    assert first_organization is not None
    dormitory, row = report_source(db_session, first_organization, "Северное")
    payload = config(dormitory.id, row.id)
    # Сотня блоков заводится напрямую: проверяется счётчик, а не ручка создания.
    db_session.add_all(
        DashboardBlock(
            config=payload, created_by_id=first_owner.id, organization_id=first_organization
        )
        for _ in range(100)
    )
    db_session.commit()

    revision = client.get("/api/dashboard/layout").json()["revision"]
    refused = client.post("/api/dashboard/blocks", json={"revision": revision, "config": payload})
    assert refused.status_code == 422
    assert "100" in refused.json()["detail"]

    # Лимит первой организации не мешает второй создать свой первый блок.
    second_owner = sign_in(client, db_session, email="second@example.com")
    second_organization = second_owner.active_organization_id
    assert second_organization is not None
    second_dormitory, second_row = report_source(db_session, second_organization, "Южное")
    created = client.post(
        "/api/dashboard/blocks",
        json={"revision": 0, "config": config(second_dormitory.id, second_row.id)},
    )
    assert created.status_code == 201, created.text
    assert len(created.json()["blocks"]) == 1
