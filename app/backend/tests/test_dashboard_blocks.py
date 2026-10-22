"""Общие блоки, точные суммы, период, скрытые источники и защита общего порядка."""

from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import report_readiness
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dashboard_block import DashboardBlock
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel, HostelCell
from app.models.report import ReportCell, ReportRow
from app.models.table_column import TableColumn
from tests.conftest import add_colleague, login, sign_in


@pytest.fixture(autouse=True)
def clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(report_readiness, "today_moscow", lambda: date(2026, 10, 9))
    monkeypatch.setattr("app.api.dashboard_blocks.today_moscow", lambda: date(2026, 10, 9))


def config(sources: list[dict[str, Any]], **changes: Any) -> dict[str, Any]:
    return {
        "name": "Мой блок",
        "display": "number",
        "source_kind": sources[0]["kind"],
        "operation": "sum",
        "period": "range",
        "grouping": "dormitory",
        "all_dormitories": False,
        "sources": sources,
        **changes,
    }


def preview(client: TestClient, payload: dict[str, Any]) -> dict[str, Any]:
    result = client.post("/api/dashboard/preview?from=2026-10-01&to=2026-10-02", json=payload)
    assert result.status_code == 200, result.text
    return result.json()


def test_shared_crud_append_order_hidden_and_stale_revision(
    client: TestClient, db_session: Session
) -> None:
    assert client.get("/api/dashboard/layout").status_code == 401
    owner = sign_in(client, db_session)
    dorm = Dormitory(name="Северное", client_name="Клиент")
    db_session.add(dorm)
    db_session.flush()
    row = ReportRow(dormitory_id=dorm.id, name="Число", position=1)
    db_session.add(row)
    db_session.commit()
    payload = config([{"kind": "report", "dormitory_id": dorm.id, "row_id": row.id}])
    created = client.post("/api/dashboard/blocks", json={"revision": 0, "config": payload})
    assert created.status_code == 201, created.text
    layout = created.json()
    block_id = layout["blocks"][0]["id"]
    key = f"custom:{block_id}"
    assert layout["order"] == ["residents", "turnover", "attendance", "reports", key]
    # Раскладка общая внутри организации: коллега видит тот же блок.
    colleague = add_colleague(db_session, owner.active_organization_id or 0)
    assert login(client, colleague.email).status_code == 200
    assert client.get("/api/dashboard/layout").json() == layout
    assert (
        client.put(
            "/api/dashboard/layout", json={"revision": 0, "order": layout["order"], "hidden": []}
        ).status_code
        == 409
    )
    order = [key, "reports", "residents", "attendance", "turnover"]
    moved = client.put(
        "/api/dashboard/layout", json={"revision": 1, "order": order, "hidden": ["reports"]}
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["order"] == order
    assert moved.json()["hidden"] == ["reports"]
    assert (
        client.put("/api/dashboard/layout", json={"revision": 2, "order": [key] * 5}).status_code
        == 422
    )
    changed = client.put(
        f"/api/dashboard/blocks/{block_id}",
        json={"revision": 2, "config": {**payload, "name": "Новое имя"}},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["order"] == order
    deleted = client.delete(f"/api/dashboard/blocks/{block_id}?revision=3")
    assert deleted.status_code == 200, deleted.text
    assert key not in deleted.json()["order"]
    assert db_session.scalar(select(DashboardBlock)) is None
    assert db_session.get(ReportRow, row.id) is not None


def table_fixture(
    db: Session, name: str, option_id: str, numbers: list[tuple[str | None, str | None]]
) -> dict[str, Any]:
    dorm = Dormitory(name=name, client_name="Клиент")
    db.add(dorm)
    db.flush()
    tab = CustomTab(dormitory_id=dorm.id, name="Статистика", table_created=True, is_active=False)
    db.add(tab)
    db.flush()
    cols = [
        TableColumn(
            dormitory_id=dorm.id,
            table_key=tab.table_key,
            name=label,
            kind=kind,
            position=index,
            options=[{"id": option_id, "label": "Сбежал", "archived": False}]
            if kind == "select"
            else [],
        )
        for index, (label, kind) in enumerate(
            [("Причина", "select"), ("Сумма", "number"), ("Дата", "date")]
        )
    ]
    db.add_all(cols)
    db.flush()
    for day, number in numbers:
        db.add(
            CustomTabEntry(
                dormitory_id=dorm.id,
                tab_id=tab.id,
                created_at=datetime(2026, 10, 1, tzinfo=UTC),
                custom_values={
                    str(cols[0].id): option_id,
                    str(cols[1].id): number,
                    str(cols[2].id): day,
                },
            )
        )
    db.commit()
    return {
        "kind": "table",
        "dormitory_id": dorm.id,
        "table_key": tab.table_key,
        "value_column_id": cols[1].id,
        "date_column_id": cols[2].id,
        "group_column_id": cols[0].id,
        "filter": {"column_id": cols[0].id, "operator": "equals", "value": option_id},
    }


def test_custom_hidden_tables_group_by_labels_and_filter_by_date(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    first = table_fixture(
        db_session,
        "Северное",
        "option-a",
        [("2026-10-01", "1.1"), ("2026-10-02", "2.2"), ("2026-09-30", "100"), (None, "200")],
    )
    second = table_fixture(db_session, "Южное", "option-b", [("2026-10-02", "4.4")])
    payload = config([first, second], display="list", grouping="value")
    result = preview(client, payload)
    assert result["value"] == 7.7
    assert result["items"] == [{"label": "Сбежал", "value": 7.7, "is_archived": False}]
    assert result["errors"] == []
    assert preview(client, {**payload, "operation": "count"})["value"] == 3
    assert preview(client, {**payload, "period": "snapshot"})["value"] == 107.7
    catalog = client.get("/api/dashboard/sources")
    assert catalog.status_code == 200, catalog.text
    assert any("скрыта" in source["name"] for dorm in catalog.json() for source in dorm["sources"])
    created = client.post("/api/dashboard/blocks", json={"revision": 0, "config": payload})
    assert created.status_code == 201, created.text
    dashboard = client.get("/api/dashboard?from=2026-10-01&to=2026-10-02")
    assert dashboard.status_code == 200, dashboard.text
    assert dashboard.json()["widgets"][0]["value"] == 7.7
    # Источник сохраняется по ID после переименования и становится явно недоступным после удаления.
    col = db_session.get(TableColumn, first["value_column_id"])
    assert col is not None
    col.name = "Другая сумма"
    db_session.commit()
    assert preview(client, payload)["value"] == 7.7
    col.archived = True
    db_session.commit()
    assert (
        client.post(
            "/api/dashboard/preview?from=2026-10-01&to=2026-10-02", json=payload
        ).status_code
        == 422
    )
    broken = client.get("/api/dashboard?from=2026-10-01&to=2026-10-02").json()["widgets"][0]
    assert broken["value"] is None and broken["errors"]
    assert all(item["value"] is None for item in broken["items"])


def test_missing_numeric_values_new_dormitory_and_invalid_cross_dormitory_column(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    first = table_fixture(db_session, "Северное", "a", [("2026-10-01", None)])
    second = table_fixture(db_session, "Южное", "b", [("2026-10-01", "0")])
    result = preview(client, config([first, second]))
    assert result["value"] is None
    assert [item["value"] for item in result["items"]] == [None, 0]
    assert len(result["errors"]) == 1
    result = preview(client, config([second], all_dormitories=True))
    assert result["value"] is None and "Не выбран источник" in result["errors"][0]
    result = preview(
        client,
        config([second], all_dormitories=True, excluded_dormitory_ids=[first["dormitory_id"]]),
    )
    assert result["value"] == 0 and result["errors"] == []
    bad = config([{**second, "value_column_id": first["value_column_id"]}])
    assert (
        client.post("/api/dashboard/preview?from=2026-10-01&to=2026-10-02", json=bad).status_code
        == 404
    )


def test_report_and_places_snapshot_range_and_missing_data(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = Dormitory(name="Северное", client_name="Клиент")
    db_session.add(dorm)
    db_session.flush()
    row = ReportRow(dormitory_id=dorm.id, name="Показатель", position=1)
    hostel = Hostel(dormitory_id=dorm.id, name="Корпус", active_from_month=date(2026, 10, 1))
    db_session.add_all([row, hostel])
    db_session.flush()
    for day, value in [(1, "3"), (2, "5")]:
        db_session.add(ReportCell(row_id=row.id, report_date=date(2026, 10, day), value=value))
        for field, number in [
            ("paid_m", 10),
            ("paid_f", 5),
            ("residents_m", 4),
            ("residents_f", 2),
        ]:
            db_session.add(
                HostelCell(
                    hostel_id=hostel.id, report_date=date(2026, 10, day), field=field, value=number
                )
            )
    db_session.commit()
    report = config([{"kind": "report", "dormitory_id": dorm.id, "row_id": row.id}])
    assert preview(client, report)["value"] == 8
    assert preview(client, {**report, "period": "snapshot"})["value"] == 5
    places = config([{"kind": "places", "dormitory_id": dorm.id, "metric": "free_total"}])
    assert preview(client, places)["value"] == 18
    assert preview(client, {**places, "period": "snapshot"})["value"] == 9
    missing = client.post(
        "/api/dashboard/preview?from=2026-10-03&to=2026-10-03", json=places
    ).json()
    assert missing["value"] is None and missing["errors"]
    future = client.post("/api/dashboard/preview?from=2099-01-01&to=2099-01-02", json=report).json()
    assert future["value"] is None


def test_chart_tables_daily_cumulative_filters_and_date_local_errors(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    first = table_fixture(
        db_session,
        "Северное",
        "a",
        [("2026-09-30", "100"), ("2026-10-01", "1.1"), ("2026-10-02", "-2.2"), (None, "200")],
    )
    second = table_fixture(db_session, "Южное", "b", [("2026-10-02", "4.4")])
    payload = config([first, second], display="chart")
    result = preview(client, payload)
    assert result["daily"] == [
        {"date": "2026-10-01", "value": 1.1},
        {"date": "2026-10-02", "value": 2.2},
    ]
    assert result["errors"] == []
    assert preview(client, {**payload, "period": "snapshot"})["daily"] == [
        {"date": "2026-10-01", "value": 101.1},
        {"date": "2026-10-02", "value": 103.3},
    ]
    compared = preview(client, {**payload, "chart_mode": "dormitories", "period": "snapshot"})
    assert [[point["value"] for point in line["daily"]] for line in compared["series"]] == [
        [101.1, 98.9],
        [0, 4.4],
    ]
    assert [
        point["value"] for point in preview(client, {**payload, "operation": "count"})["daily"]
    ] == [1, 2]
    # A missing number invalidates only its day; cumulative values remain incomplete thereafter.
    entry = db_session.scalar(
        select(CustomTabEntry).where(CustomTabEntry.dormitory_id == first["dormitory_id"])
    )
    assert entry is not None
    entry.custom_values = {
        **entry.custom_values,
        str(first["date_column_id"]): "2026-10-01",
        str(first["value_column_id"]): None,
    }
    db_session.commit()
    result = preview(client, payload)
    assert [point["value"] for point in result["daily"]] == [None, 2.2]
    assert len(result["errors"]) == 1 and "01.10.2026" in result["errors"][0]
    assert all(
        point["value"] is None
        for point in preview(client, {**payload, "period": "snapshot"})["daily"]
    )
    # Creation dates use Moscow time when no date column is chosen.
    second_entry = db_session.scalar(
        select(CustomTabEntry).where(CustomTabEntry.dormitory_id == second["dormitory_id"])
    )
    assert second_entry is not None
    second_entry.created_at = datetime(2026, 9, 30, 21, 30, tzinfo=UTC)
    db_session.commit()
    counted = preview(
        client, config([{**second, "date_column_id": None}], display="chart", operation="count")
    )
    assert [point["value"] for point in counted["daily"]] == [1, 0]
    assert (
        client.post(
            "/api/dashboard/preview?from=2026-10-01&to=2026-10-02",
            json={**payload, "grouping": "value"},
        ).status_code
        == 422
    )


def test_chart_report_values_gaps_and_saved_dashboard(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    sources = []
    for name, cells in [
        ("Северное", [(1, "3"), (2, "0"), (3, "-2")]),
        ("Южное", [(1, "5"), (3, "1")]),
    ]:
        dorm = Dormitory(name=name, client_name="Клиент", is_archived=name == "Южное")
        db_session.add(dorm)
        db_session.flush()
        row = ReportRow(dormitory_id=dorm.id, name="Показатель", position=1)
        db_session.add(row)
        db_session.flush()
        sources.append({"kind": "report", "dormitory_id": dorm.id, "row_id": row.id})
        for day, value in cells:
            db_session.add(ReportCell(row_id=row.id, report_date=date(2026, 10, day), value=value))
    db_session.commit()
    payload = config(sources, display="chart")
    result = client.post("/api/dashboard/preview?from=2026-10-01&to=2026-10-03", json=payload)
    assert result.status_code == 200, result.text
    assert [point["value"] for point in result.json()["daily"]] == [8, None, -1]
    assert len(result.json()["errors"]) == 1
    compared = client.post(
        "/api/dashboard/preview?from=2026-10-01&to=2026-10-03",
        json={**payload, "chart_mode": "dormitories"},
    ).json()
    assert [line["label"] for line in compared["series"]] == ["Северное", "Южное"]
    assert [line["is_archived"] for line in compared["series"]] == [False, True]
    assert [[point["value"] for point in line["daily"]] for line in compared["series"]] == [
        [3, 0, -2],
        [5, None, 1],
    ]
    assert result.json()["series"] == []  # Existing charts keep their aggregate display.
    created = client.post("/api/dashboard/blocks", json={"revision": 0, "config": payload})
    assert created.status_code == 201, created.text
    assert created.json()["blocks"][0]["config"]["display"] == "chart"
    dashboard = client.get("/api/dashboard?from=2026-10-01&to=2026-10-03")
    assert dashboard.status_code == 200, dashboard.text
    assert dashboard.json()["widgets"][0]["daily"] == result.json()["daily"]
    future = client.post(
        "/api/dashboard/preview?from=2099-01-01&to=2099-01-02", json=payload
    ).json()
    assert future["daily"] == [] and future["errors"]
    cut = client.post("/api/dashboard/preview?from=2026-10-09&to=2026-10-31", json=payload).json()
    assert [point["date"] for point in cut["daily"]] == ["2026-10-09"]


def test_chart_places_preserves_valid_days_and_derived_negative_values(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = Dormitory(name="Северное", client_name="Клиент")
    db_session.add(dorm)
    db_session.flush()
    hostel = Hostel(dormitory_id=dorm.id, name="Корпус", active_from_month=date(2026, 10, 1))
    db_session.add(hostel)
    db_session.flush()
    for day, paid, residents in [(1, 3, 5), (3, 10, 6)]:
        for field, number in [
            ("paid_m", paid),
            ("paid_f", 0),
            ("residents_m", residents),
            ("residents_f", 0),
        ]:
            db_session.add(
                HostelCell(
                    hostel_id=hostel.id, report_date=date(2026, 10, day), field=field, value=number
                )
            )
    db_session.commit()
    payload = config(
        [{"kind": "places", "dormitory_id": dorm.id, "metric": "free_total"}], display="chart"
    )
    result = client.post("/api/dashboard/preview?from=2026-10-01&to=2026-10-03", json=payload)
    assert result.status_code == 200, result.text
    assert [point["value"] for point in result.json()["daily"]] == [-2, None, 4]
    assert len(result.json()["errors"]) == 1
    compared = client.post(
        "/api/dashboard/preview?from=2026-10-01&to=2026-10-03",
        json={**payload, "chart_mode": "dormitories"},
    ).json()
    assert compared["series"][0]["daily"] == result.json()["daily"]
    db_session.add(Dormitory(name="Новое без настройки", client_name="Клиент"))
    db_session.commit()
    incomplete = preview(client, {**payload, "all_dormitories": True})
    assert all(point["value"] is None for point in incomplete["daily"])
    assert any("Не выбран источник" in message for message in incomplete["errors"])


def test_comparison_chart_saves_shared_mode_and_isolates_unavailable_sources(
    client: TestClient, db_session: Session
) -> None:
    owner = sign_in(client, db_session)
    first = table_fixture(db_session, "Общежитие", "a", [("2026-10-01", "2")])
    second = table_fixture(db_session, "Общежитие", "b", [("2026-10-01", "5")])
    payload = config([second, first], display="chart", chart_mode="dormitories")
    created = client.post("/api/dashboard/blocks", json={"revision": 0, "config": payload})
    assert created.status_code == 201, created.text
    assert created.json()["blocks"][0]["config"]["chart_mode"] == "dormitories"
    column = db_session.get(TableColumn, first["value_column_id"])
    assert column is not None
    column.archived = True
    db_session.commit()
    # Сравнительный график видят коллеги по организации.
    colleague = add_colleague(db_session, owner.active_organization_id or 0)
    assert login(client, colleague.email).status_code == 200
    result = client.get("/api/dashboard?from=2026-10-01&to=2026-10-02").json()["widgets"][0]
    assert [line["dormitory_id"] for line in result["series"]] == [
        first["dormitory_id"],
        second["dormitory_id"],
    ]
    assert [point["value"] for point in result["series"][0]["daily"]] == [None, None]
    assert [point["value"] for point in result["series"][1]["daily"]] == [5, 0]
    assert all(point["value"] is None for point in result["daily"])
    assert len(result["errors"]) == 1
