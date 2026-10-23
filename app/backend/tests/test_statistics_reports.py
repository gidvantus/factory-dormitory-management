"""Сохранение, доступ и расчёт статистики на меняющейся структуре источников."""

from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTab
from app.models.dormitory import Dormitory
from app.models.report import ReportCell, ReportRow
from tests.conftest import add_colleague, login, sign_in
from tests.test_dashboard_blocks import table_fixture


@pytest.fixture(autouse=True)
def clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.api.statistics_reports.today_moscow", lambda: date(2026, 10, 10))


def report_source(db: Session, name: str, values: list[str | None]) -> dict[str, Any]:
    dorm = Dormitory(name=name, client_name="Клиент")
    db.add(dorm)
    db.flush()
    row = ReportRow(dormitory_id=dorm.id, name="Выход Итого", position=1)
    db.add(row)
    db.flush()
    for day, value in enumerate(values, 1):
        if value is not None:
            db.add(ReportCell(row_id=row.id, report_date=date(2026, 10, day), value=value))
    db.commit()
    return {"kind": "report", "dormitory_id": dorm.id, "row_id": row.id}


def block(source: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        "id": "test-block",
        "name": "Выход",
        "display": "table",
        "aggregation": "sum",
        "breakdown": "date",
        "selected_dormitory_ids": [],
        "query": {
            "name": "Выход",
            "display": "chart",
            "chart_mode": "dormitories",
            "source_kind": source["kind"],
            "operation": "sum",
            "period": "range",
            "grouping": "dormitory",
            "all_dormitories": True,
            "excluded_dormitory_ids": [],
            "sources": [source],
        },
        **changes,
    }


def create(
    client: TestClient, blocks: list[dict[str, Any]] | None = None, **changes: Any
) -> dict[str, Any]:
    response = client.post(
        "/api/statistics/reports",
        json={"name": "Выход персонала", "blocks": blocks or [], **changes},
    )
    assert response.status_code == 201, response.text
    return response.json()


def update_payload(report: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        key: changes.get(key, report[key])
        for key in ("name", "description", "visibility", "blocks", "revision")
    }


def test_persistence_shared_personal_and_conflicts(client: TestClient, db_session: Session) -> None:
    assert client.get("/api/statistics/reports").status_code == 401
    owner = sign_in(client, db_session)
    shared = create(client)
    personal = create(client, visibility="personal")
    assert shared["created_by_id"] == owner.id
    assert client.get(f"/api/statistics/reports/{shared['id']}").json() == shared
    assert len(client.get("/api/statistics/reports").json()) == 2

    # Другая организация не видит ни `shared`, ни `personal`: организация —
    # внешняя граница, а видимость действует только внутри неё.
    sign_in(client, db_session, email="second@example.com")
    assert client.get("/api/statistics/reports").json() == []
    for report in (shared, personal):
        assert client.get(f"/api/statistics/reports/{report['id']}").status_code == 404
        assert (
            client.get(
                f"/api/statistics/reports/{report['id']}/data?from=2026-10-01&to=2026-10-02"
            ).status_code
            == 404
        )
        assert (
            client.put(
                f"/api/statistics/reports/{report['id']}", json=update_payload(report)
            ).status_code
            == 404
        )

    # Коллега **той же** организации: `shared` виден, `personal` — нет, а менять
    # доступ и удалять по-прежнему может только создатель.
    assert owner.active_organization_id is not None
    colleague = add_colleague(
        db_session, owner.active_organization_id, email="colleague@example.com"
    )
    assert login(client, colleague.email).status_code == 200
    assert [item["id"] for item in client.get("/api/statistics/reports").json()] == [shared["id"]]
    assert client.get(f"/api/statistics/reports/{personal['id']}").status_code == 404
    assert (
        client.put(
            f"/api/statistics/reports/{personal['id']}", json=update_payload(personal)
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/api/statistics/reports/{shared['id']}",
            json=update_payload(shared, visibility="personal"),
        ).status_code
        == 403
    )
    assert client.delete(f"/api/statistics/reports/{shared['id']}?revision=1").status_code == 403

    # Создатель продолжает править свой отчёт, и ревизия по-прежнему защищает.
    assert login(client, owner.email).status_code == 200
    changed = client.put(
        f"/api/statistics/reports/{shared['id']}",
        json=update_payload(shared, name="Новое название"),
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["revision"] == 1
    assert (
        client.put(
            f"/api/statistics/reports/{shared['id']}", json=update_payload(shared)
        ).status_code
        == 409
    )


@pytest.mark.parametrize(
    ("operation", "expected"), [("sum", 11.7), ("average", 5.85), ("last", 6.1), ("max", 6.1)]
)
def test_real_values_aggregation_and_future_dates(
    client: TestClient, db_session: Session, operation: str, expected: float
) -> None:
    sign_in(client, db_session)
    source = report_source(db_session, "Северное", ["1.1", "2.2"])
    report_source(db_session, "Южное", ["4.5", "3.9"])
    report = create(client, [block(source, aggregation=operation)])
    result = client.get(
        f"/api/statistics/reports/{report['id']}/data?from=2026-10-01&to=2026-10-02"
    )
    assert result.status_code == 200, result.text
    data = result.json()["results"][0]
    assert data["value"] == expected
    assert data["daily"] == [
        {"date": "2026-10-01", "value": 5.6},
        {"date": "2026-10-02", "value": 6.1},
    ]
    assert len(data["series"]) == 2
    assert data["errors"] == []
    future = client.get(
        f"/api/statistics/reports/{report['id']}/data?from=2026-11-01&to=2026-11-30"
    ).json()
    assert future["through_date"] is None
    assert future["results"][0]["value"] is None
    assert future["results"][0]["daily"] == []


def test_dynamic_catalog_auto_new_dormitory_renames_and_missing_data(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    source = report_source(db_session, "Северное", ["10", "20"])
    report = create(client, [block(source)])
    endpoint = f"/api/statistics/reports/{report['id']}/data?from=2026-10-01&to=2026-10-02"
    assert client.get(endpoint).json()["results"][0]["value"] == 30
    second = report_source(db_session, "Новое", ["3", None])
    data = client.get(endpoint).json()["results"][0]
    assert data["value"] is None
    assert data["daily"][0]["value"] == 13
    assert data["daily"][1]["value"] is None
    assert data["errors"]
    row = db_session.get(ReportRow, source["row_id"])
    row.name = "Переименованный выход"
    db_session.add(
        ReportRow(
            dormitory_id=source["dormitory_id"], name="Новая строка", position=2, formula="=7"
        )
    )
    tab = CustomTab(dormitory_id=source["dormitory_id"], name="Новая вкладка", table_created=True)
    db_session.add(tab)
    db_session.commit()
    catalog = client.get("/api/statistics/sources").json()
    first = next(dorm for dorm in catalog if dorm["id"] == source["dormitory_id"])
    assert any(item["key"] == tab.table_key for item in first["sources"])
    assert any(row["name"] == "Новая строка" for item in first["sources"] for row in item["rows"])
    saved = report["blocks"][0]
    saved["query"]["sources"].append(second)
    saved["query"]["all_dormitories"] = False
    saved["selected_dormitory_ids"] = [source["dormitory_id"]]
    changed = client.put(
        f"/api/statistics/reports/{report['id']}", json=update_payload(report, blocks=[saved])
    )
    assert changed.status_code == 200, changed.text
    assert client.get(endpoint).json()["results"][0]["value"] == 30
    # A report-wide dormitory filter must not mark other selected dormitories as deleted.
    saved["selected_dormitory_ids"].append(second["dormitory_id"])
    changed = client.put(
        f"/api/statistics/reports/{report['id']}",
        json=update_payload(changed.json(), blocks=[saved]),
    )
    filtered = client.get(endpoint + f"&dormitory_id={source['dormitory_id']}").json()["results"][0]
    assert filtered["value"] == 30
    assert filtered["errors"] == []
    db_session.delete(row)
    db_session.commit()
    assert client.get(endpoint).json()["results"][0]["value"] is None
    # Removing a broken block remains possible.
    assert (
        client.put(
            f"/api/statistics/reports/{report['id']}",
            json=update_payload(changed.json(), blocks=[]),
        ).status_code
        == 200
    )


def test_saved_auto_matches_keep_identifiers_after_renames(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    source = report_source(db_session, "Первое", ["10", "20"])
    second = report_source(db_session, "Второе", ["3", "4"])
    report = create(client, [block(source)])
    assert {item["row_id"] for item in report["blocks"][0]["query"]["sources"]} == {
        source["row_id"],
        second["row_id"],
    }
    row = db_session.get(ReportRow, second["row_id"])
    row.name = "Другое название после сохранения"
    db_session.commit()
    result = client.get(
        f"/api/statistics/reports/{report['id']}/data?from=2026-10-01&to=2026-10-02"
    )
    assert result.status_code == 200, result.text
    assert result.json()["results"][0]["value"] == 37
    assert result.json()["results"][0]["errors"] == []


def test_custom_tables_dates_filters_and_live_changes(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    source = table_fixture(
        db_session,
        "Северное",
        "first-option",
        [("2026-10-01", "1.1"), ("2026-10-02", "2.2"), (None, "50")],
    )
    table_fixture(db_session, "Новое", "other-option", [("2026-10-02", "4.4")])
    query = block(source)
    response = client.post("/api/statistics/preview?from=2026-10-01&to=2026-10-02", json=query)
    assert response.status_code == 200, response.text
    assert response.json()["value"] == 7.7
    assert response.json()["errors"] == []
    query["query"]["operation"] = "count"
    assert (
        client.post("/api/statistics/preview?from=2026-10-01&to=2026-10-02", json=query).json()[
            "value"
        ]
        == 3
    )
    assert (
        client.post("/api/statistics/preview?from=2026-10-03&to=2026-10-02", json=query).status_code
        == 422
    )
    query["query"]["operation"] = "sum"
    report = create(client, [query])
    assert client.delete(f"/api/statistics/reports/{report['id']}?revision=9").status_code == 409
    assert client.delete(f"/api/statistics/reports/{report['id']}?revision=0").status_code == 204
    assert client.get(f"/api/statistics/reports/{report['id']}").status_code == 404


def test_validate_duplicate_blocks_and_inactive_access(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    source = report_source(db_session, "Северное", ["0"])
    assert (
        client.post("/api/statistics/reports", json={"name": " ", "blocks": []}).status_code == 422
    )
    assert (
        client.post(
            "/api/statistics/reports",
            json={"name": "Отчёт", "blocks": [block(source), block(source)]},
        ).status_code
        == 422
    )
    sign_in(client, db_session, email="inactive@example.com", is_active=False)
    assert client.get("/api/statistics/sources").status_code == 403
