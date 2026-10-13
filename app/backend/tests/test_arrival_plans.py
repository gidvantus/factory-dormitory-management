"""Ручной план по датам, действующие общежития и связь с общим отчётом."""

from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.arrival_plan import ArrivalPlan
from app.models.personnel import Employee
from tests.conftest import sign_in
from tests.test_reports import create_dormitory

API = "/api/personnel/arrivals"


def create(
    client: TestClient,
    dorm: int,
    day: str = "2026-10-20",
    count: int = 10,
    names: list[str] | None = None,
) -> dict[str, Any]:
    response = client.post(
        API, json={"dormitory_id": dorm, "date": day, "count": count, "names": names or []}
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_manual_count_partial_names_and_revision(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    plan = create(client, dorm, names=["  Иванов  Иван ", "Петров Пётр"])
    assert plan["names"] == ["Иванов Иван", "Петров Пётр"]
    assert plan["count"] == 10
    assert client.get("/api/personnel").json()["arrival_plans"] == [plan]
    assert db_session.scalar(select(func.count()).select_from(Employee)) == 0
    assert (
        client.post(API, json={"dormitory_id": dorm, "date": plan["date"], "count": 4}).status_code
        == 409
    )
    body = {"dormitory_id": dorm, "date": plan["date"], "count": 12, "names": [], "revision": 0}
    changed = client.put(f"{API}/{plan['id']}", json=body)
    assert changed.status_code == 200, changed.text
    assert changed.json()["revision"] == 1
    assert changed.json()["count"] == 12
    assert client.put(f"{API}/{plan['id']}", json=body).status_code == 409
    assert client.delete(f"{API}/{plan['id']}?revision=0").status_code == 409
    assert client.delete(f"{API}/{plan['id']}?revision=1").status_code == 204
    assert client.get("/api/personnel").json()["arrival_plans"] == []


@pytest.mark.parametrize(
    "extra",
    [
        {"count": 0},
        {"count": -1},
        {"count": 1.5},
        {"count": True},
        {"count": 10001},
        {"count": 1, "names": ["Иванов", "Петров"]},
        {"names": [" "]},
        {"names": ["a" * 256]},
        {"date": "2026-02-30"},
        {"confirmed": True},
    ],
)
def test_invalid_arrivals_rejected(
    client: TestClient, db_session: Session, extra: dict[str, Any]
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    response = client.post(
        API, json={"dormitory_id": dorm, "date": "2026-10-20", "count": 10, **extra}
    )
    assert response.status_code == 422, response.text
    assert db_session.scalar(select(func.count()).select_from(ArrivalPlan)) == 0


def test_archived_dormitory_excluded_but_report_retains_plan(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    plan = create(client, dorm)
    assert client.patch(f"/api/dormitories/{dorm}", json={"is_archived": True}).status_code == 200
    assert client.get("/api/personnel").json()["arrival_plans"] == []
    assert (
        client.post(API, json={"dormitory_id": dorm, "date": "2026-10-21", "count": 2}).status_code
        == 409
    )
    body = {key: plan[key] for key in ("dormitory_id", "date", "count", "names", "revision")}
    assert client.put(f"{API}/{plan['id']}", json=body).status_code == 409
    assert client.delete(f"{API}/{plan['id']}?revision=0").status_code == 409
    assert db_session.get(ArrivalPlan, plan["id"]).count == 10
    assert client.patch(f"/api/dormitories/{dorm}", json={"is_archived": False}).status_code == 200
    assert client.get("/api/personnel").json()["arrival_plans"] == [plan]


def test_report_counts_people_by_date_and_dormitory_and_updates_live(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    other = create_dormitory(client, "Второе")
    first = create(client, dorm, count=10, names=["Иванов Иван"])
    create(client, dorm, "2026-10-21", count=4)
    create(client, other, count=80)
    base = f"/api/dormitories/{dorm}/report"
    response = client.post(
        f"{base}/rows", json={"name": "Ожидается заезд", "link": {"table_key": "arrival_plan"}}
    )
    assert response.status_code == 201, response.text
    row_id = response.json()["id"]
    formula = client.post(
        f"{base}/rows", json={"name": "Проверка формулы", "formula": "=[Ожидается заезд]+2"}
    )
    assert formula.status_code == 201, formula.text

    def values() -> dict[str, str | None]:
        report = client.get(f"{base}?from=2026-10-20&to=2026-10-22")
        assert report.status_code == 200, report.text
        rows = report.json()["rows"]
        assert rows[-1]["values"]["2026-10-21"] == "6"
        assert rows[-2]["errors"] == {}
        return rows[-2]["values"]

    assert values() == {"2026-10-20": "10", "2026-10-21": "4", "2026-10-22": "0"}
    assert (
        client.put(f"{base}/rows/{row_id}/cells/2026-10-20", json={"value": "99"}).status_code
        == 409
    )
    assert (
        client.put(
            f"{API}/{first['id']}",
            json={"dormitory_id": dorm, "date": "2026-10-20", "count": 12, "revision": 0},
        ).status_code
        == 200
    )
    assert values()["2026-10-20"] == "12"
    assert client.delete(f"{API}/{first['id']}?revision=1").status_code == 204
    assert values()["2026-10-20"] == "0"
    client.patch(f"/api/dormitories/{dorm}", json={"is_archived": True})
    assert values()["2026-10-21"] == "4"


def test_report_template_keeps_link_without_copying_arrival_data(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    source = create_dormitory(client)
    create(client, source)
    assert (
        client.post(
            f"/api/dormitories/{source}/report/rows",
            json={"name": "План", "link": {"table_key": "arrival_plan"}},
        ).status_code
        == 201
    )
    template = client.post(
        "/api/report-templates", json={"name": "С заездами", "dormitory_id": source}
    )
    assert template.status_code == 201, template.text
    target = client.post(
        "/api/dormitories",
        json={"name": "Новое", "client_name": "Клиент", "template_id": template.json()["id"]},
    )
    assert target.status_code == 201, target.text
    target_id = target.json()["id"]
    row = client.get(f"/api/dormitories/{target_id}/report?from=2026-10-20&to=2026-10-20").json()[
        "rows"
    ][-1]
    assert row["link"] == {"table_key": "arrival_plan"}
    assert row["values"] == {"2026-10-20": "0"}
    create(client, target_id, count=3)
    row = client.get(f"/api/dormitories/{target_id}/report?from=2026-10-20&to=2026-10-20").json()[
        "rows"
    ][-1]
    assert row["values"] == {"2026-10-20": "3"}


def test_arrivals_require_authentication(client: TestClient) -> None:
    assert (
        client.post(API, json={"dormitory_id": 1, "date": "2026-10-20", "count": 10}).status_code
        == 401
    )


def test_selected_dormitory_structure_preserves_arrival_report_source(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    source = create_dormitory(client)
    create(client, source)
    client.post(
        f"/api/dormitories/{source}/report/rows",
        json={"name": "План", "link": {"table_key": "arrival_plan"}},
    )
    response = client.post(
        "/api/dormitories",
        json={
            "name": "Копия отчёта",
            "client_name": "Клиент",
            "tabs": [{"source_id": f"standard:{source}:report"}],
        },
    )
    assert response.status_code == 201, response.text
    target = response.json()["id"]
    row = client.get(f"/api/dormitories/{target}/report?from=2026-10-20&to=2026-10-20").json()[
        "rows"
    ][-1]
    assert row["link"] == {"table_key": "arrival_plan"}
    assert row["values"] == {"2026-10-20": "0"}


def test_moves_reject_duplicate_dates_without_losing_data(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    first = create(client, dorm)
    second = create(client, dorm, "2026-10-21", count=4)
    result = client.put(
        f"{API}/{first['id']}",
        json={"dormitory_id": dorm, "date": second["date"], "count": 20, "revision": 0},
    )
    assert result.status_code == 409
    original = db_session.get(ArrivalPlan, first["id"])
    assert original.count == 10
    assert original.date == date(2026, 10, 20)
    assert original.revision == 0


def test_full_structure_template_copies_arrival_link_without_plan_values(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    source = create_dormitory(client)
    create(client, source)
    client.post(
        f"/api/dormitories/{source}/report/rows",
        json={"name": "План", "link": {"table_key": "arrival_plan"}},
    )
    template = client.post(
        "/api/dormitory-templates", json={"name": "Структура с планом", "dormitory_id": source}
    )
    assert template.status_code == 201, template.text
    response = client.post(
        "/api/dormitories",
        json={
            "name": "Копия структуры",
            "client_name": "Клиент",
            "structure_template_id": template.json()["id"],
        },
    )
    assert response.status_code == 201, response.text
    target = response.json()["id"]
    row = client.get(f"/api/dormitories/{target}/report?from=2026-10-20&to=2026-10-20").json()[
        "rows"
    ][-1]
    assert row["link"] == {"table_key": "arrival_plan"}
    assert row["values"] == {"2026-10-20": "0"}
