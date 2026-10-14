"""План заездов как общий источник блоков, включая будущие даты."""

from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.report import ReportCell, ReportRow
from tests.conftest import sign_in
from tests.test_arrival_plans import create as arrival
from tests.test_dashboard_blocks import config
from tests.test_statistics_reports import block, create

PERIOD = "from=2026-10-20&to=2026-10-22"


@pytest.fixture(autouse=True)
def clock(monkeypatch: pytest.MonkeyPatch) -> None:
    for module in (
        "app.report_readiness",
        "app.api.dashboard_blocks",
        "app.api.statistics_reports",
    ):
        monkeypatch.setattr(f"{module}.today_moscow", lambda: date(2026, 10, 14))


def dormitory(db: Session, name: str) -> Dormitory:
    dorm = Dormitory(name=name, client_name="Клиент", section_states={"report": "deleted"})
    db.add(dorm)
    db.commit()
    return dorm


def source(dorm: Dormitory) -> dict[str, Any]:
    return {"kind": "arrival_plan", "dormitory_id": dorm.id}


@pytest.mark.parametrize(("period", "expected"), [("range", 17), ("snapshot", 7)])
def test_dashboard_manual_counts_future_dates_and_new_dormitory(
    client: TestClient, db_session: Session, period: str, expected: int
) -> None:
    sign_in(client, db_session)
    first = dormitory(db_session, "Северное")
    arrival(client, first.id, "2026-10-20", 10, ["Иванов Иван"])
    arrival(client, first.id, "2026-10-19", 100)
    payload = config([source(first)], all_dormitories=True, period=period, display="list")
    saved = client.post("/api/dashboard/blocks", json={"revision": 0, "config": payload})
    assert saved.status_code == 201, saved.text
    second = dormitory(db_session, "Новое")
    arrival(client, second.id, "2026-10-22", 7)
    preview = client.post(f"/api/dashboard/preview?{PERIOD}", json=payload)
    assert preview.status_code == 200, preview.text
    assert preview.json()["value"] == expected
    data = client.get(f"/api/dashboard?{PERIOD}")
    assert data.status_code == 200, data.text
    result = data.json()["widgets"][0]
    assert result["value"] == expected
    assert result["errors"] == []
    assert len(result["items"]) == 2
    assert data.json()["snapshot_date"] is None
    assert data.json()["totals"]["residents"] is None
    catalog = client.get("/api/dashboard/sources").json()
    assert all(any(item["kind"] == "arrival_plan" for item in dorm["sources"]) for dorm in catalog)


def test_daily_charts_scope_and_archived_history(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    first = dormitory(db_session, "Северное")
    second = dormitory(db_session, "Южное")
    arrival(client, first.id, "2026-10-20", 10, ["Иванов Иван"])
    arrival(client, second.id, "2026-10-22", 7)
    second.is_archived = True
    db_session.commit()
    payload = config(
        [source(first)], all_dormitories=True, display="chart", chart_mode="dormitories"
    )
    response = client.post(f"/api/dashboard/preview?{PERIOD}", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert [point["value"] for point in result["daily"]] == [10, 0, 7]
    assert result["series"][1]["is_archived"] is True
    assert [point["value"] for point in result["series"][0]["daily"]] == [10, 0, 0]
    excluded = client.post(
        f"/api/dashboard/preview?{PERIOD}",
        json={**payload, "excluded_dormitory_ids": [second.id]},
    ).json()
    assert [point["value"] for point in excluded["daily"]] == [10, 0, 0]
    assert len(excluded["series"]) == 1
    selected = client.post(
        f"/api/dashboard/preview?{PERIOD}", json={**payload, "all_dormitories": False}
    ).json()
    assert selected["daily"] == excluded["daily"]


@pytest.mark.parametrize(
    ("operation", "expected"), [("sum", 18), ("average", 6), ("last", 7), ("max", 11)]
)
def test_statistics_future_aggregations_and_global_dormitory_filter(
    client: TestClient, db_session: Session, operation: str, expected: int
) -> None:
    sign_in(client, db_session)
    first = dormitory(db_session, "Северное")
    arrival(client, first.id, "2026-10-20", 11, ["Иванов Иван"])
    payload = block(source(first), aggregation=operation)
    saved = create(client, [payload])
    second = dormitory(db_session, "Новое")
    arrival(client, second.id, "2026-10-22", 7)
    preview = client.post(f"/api/statistics/preview?{PERIOD}", json=payload)
    assert preview.status_code == 200, preview.text
    assert preview.json()["value"] == expected
    data = client.get(f"/api/statistics/reports/{saved['id']}/data?{PERIOD}")
    assert data.status_code == 200, data.text
    result = data.json()["results"][0]
    assert result["value"] == expected
    assert [point["value"] for point in result["daily"]] == [11, 0, 7]
    assert result["errors"] == []
    scoped = client.get(
        f"/api/statistics/reports/{saved['id']}/data?{PERIOD}&dormitory_id={second.id}"
    ).json()["results"][0]
    assert [point["value"] for point in scoped["daily"]] == [0, 0, 7]
    assert len(scoped["items"]) == 1


def test_mixed_sources_keep_actual_cutoff_and_recalculate_after_plan_changes(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = dormitory(db_session, "Северное")
    dorm.section_states = {}
    row = ReportRow(dormitory_id=dorm.id, name="Факт", position=0)
    db_session.add(row)
    db_session.flush()
    db_session.add(ReportCell(row_id=row.id, report_date=date(2026, 10, 14), value="2"))
    db_session.commit()
    plan = arrival(client, dorm.id, "2026-10-16", 10, ["Иванов Иван"])
    actual_source = {"kind": "report", "dormitory_id": dorm.id, "row_id": row.id}
    saved = create(client, [block(source(dorm)), block(actual_source, id="actual")])
    query = "from=2026-10-14&to=2026-10-16"
    url = f"/api/statistics/reports/{saved['id']}/data?{query}"
    data = client.get(url).json()
    assert data["through_date"] == "2026-10-14"
    planned, actual = data["results"]
    assert planned["value"] == 10
    assert actual["value"] == 2
    assert actual["daily"] == [{"date": "2026-10-14", "value": 2}]
    for index, item in enumerate([source(dorm), actual_source]):
        response = client.post(
            "/api/dashboard/blocks", json={"revision": index, "config": config([item])}
        )
        assert response.status_code == 201, response.text
    dashboard = client.get(f"/api/dashboard?{query}").json()
    assert [item["value"] for item in dashboard["widgets"]] == [10, 2]
    update = client.put(
        f"/api/personnel/arrivals/{plan['id']}",
        json={
            "dormitory_id": dorm.id,
            "date": plan["date"],
            "count": 12,
            "names": [],
            "revision": 0,
        },
    )
    assert update.status_code == 200, update.text
    assert client.get(url).json()["results"][0]["value"] == 12
    assert client.get(f"/api/dashboard?{query}").json()["widgets"][0]["value"] == 12
    assert client.delete(f"/api/personnel/arrivals/{plan['id']}?revision=1").status_code == 204
    assert client.get(url).json()["results"][0]["value"] == 0
    assert client.get(f"/api/dashboard?{query}").json()["widgets"][0]["value"] == 0
    future_actual = client.post(f"/api/dashboard/preview?{PERIOD}", json=config([actual_source]))
    assert future_actual.json()["value"] is None


def test_plan_source_validates_scope_and_period(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    dorm = dormitory(db_session, "Северное")
    payload = config([source(dorm)])
    assert (
        client.post(
            "/api/dashboard/preview?from=2026-10-22&to=2026-10-20", json=payload
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/statistics/preview?from=2026-01-01&to=2027-01-03", json=block(source(dorm))
        ).status_code
        == 422
    )
    bad = config([{"kind": "arrival_plan", "dormitory_id": dorm.id + 100}])
    assert client.post(f"/api/dashboard/preview?{PERIOD}", json=bad).status_code == 404
    assert (
        client.post(
            f"/api/dashboard/preview?{PERIOD}", json={**payload, "operation": "count"}
        ).status_code
        == 422
    )
