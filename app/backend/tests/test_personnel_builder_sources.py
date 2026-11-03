"""Связи с настоящими таблицами, отчётами, размещением и защита источников."""

from datetime import date
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.hostel import Hostel, HostelCell
from tests.conftest import sign_in
from tests.test_arrival_plans import create as create_arrival
from tests.test_custom_tab_options import create as create_calendar
from tests.test_custom_tabs import tab
from tests.test_personnel import create as create_person
from tests.test_personnel import legacy_merge
from tests.test_personnel_builder import BASE, column, link, state, table
from tests.test_reports import create_dormitory, create_row


def source_table(client: TestClient, dorm: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    source = tab(client, dorm, "Ставки")
    base = f"/api/dormitories/{dorm}"
    created = client.post(
        f"{base}/tabs/{source['id']}/table",
        json={"columns": [{"name": "Дата", "kind": "date"}, {"name": "Сумма", "kind": "number"}]},
    )
    assert created.status_code == 201, created.text
    columns = [
        c
        for c in client.get(f"{base}/tables/{source['table_key']}/columns").json()
        if c["kind"] != "action"
    ]
    for day, amount in (("2026-11-02", "125"), ("2026-11-03", "275")):
        row = client.post(f"{base}/tabs/{source['id']}/rows").json()
        for col, value in zip(columns, [day, amount], strict=True):
            response = client.put(
                f"{base}/tables/{source['table_key']}/rows/{row['id']}/cells/{col['id']}",
                json={"value": value},
            )
            assert response.status_code == 200, response.text
    return source, columns


def test_real_table_links_dates_changes_and_column_guard(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    source, columns = source_table(client, dorm)
    rule = link(
        f"dorm:{dorm}:{source['table_key']}", str(columns[1]["id"]), dateField=str(columns[0]["id"])
    )
    data = state(
        table(
            "work", "Расчёт", [column("total", "Итого", rule=rule)], [{"id": "row", "values": {}}]
        )
    )
    result = client.post(
        f"{BASE}/evaluate",
        json={"state": data, "tabId": "work", "from": "2026-11-02", "to": "2026-11-03"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["columns"]["row"]["total"] == {"value": 400}
    assert client.put(BASE, json={"revision": 0, "state": data}).status_code == 200
    removed = client.delete(
        f"/api/dormitories/{dorm}/tables/{source['table_key']}/columns/{columns[1]['id']}"
    )
    assert removed.status_code == 409 and "Персонал" in removed.text
    catalog = client.get(f"{BASE}/sources").json()
    assert any(item["id"] == f"dorm:{dorm}:{source['table_key']}" for item in catalog["sources"])
    assert any(item["templateLabel"].startswith("Ставки") for item in catalog["templates"])


def test_report_and_places_sources_and_report_row_guard(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    report = f"/api/dormitories/{dorm}/report"
    row = create_row(client, report, "Ручной показатель")
    assert (
        client.put(f"{report}/rows/{row}/cells/2026-11-02", json={"value": "12"}).status_code == 204
    )
    hostel = Hostel(dormitory_id=dorm, name="Корпус", active_from_month=date(2026, 11, 1))
    db_session.add(hostel)
    db_session.flush()
    db_session.add_all(
        [
            HostelCell(hostel_id=hostel.id, report_date=date(2026, 11, 2), field=key, value=value)
            for key, value in {
                "residents_m": 2,
                "residents_f": 1,
                "paid_m": 10,
                "paid_f": 5,
            }.items()
        ]
    )
    db_session.commit()
    data = state(
        table(
            "work",
            "Расчёт",
            [
                column(
                    "report",
                    "Отчёт",
                    rule=link(f"report:{dorm}", "$value", sourceRowId=str(row), dateField="$date"),
                ),
                column(
                    "places",
                    "Свободные места",
                    rule=link(f"places:{dorm}", "free_total", dateField="$date"),
                ),
            ],
            [{"id": "row", "values": {}}],
        )
    )
    result = client.post(
        f"{BASE}/evaluate",
        json={"state": data, "tabId": "work", "from": "2026-11-02", "to": "2026-11-02"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["columns"]["row"] == {"report": {"value": 12}, "places": {"value": 12}}
    assert client.put(BASE, json={"revision": 0, "state": data}).status_code == 200
    deleted = client.delete(f"{report}/rows/{row}")
    assert deleted.status_code == 409 and "Персонал" in deleted.text


def test_source_without_rows_cannot_be_deleted_while_count_link_exists(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    source = tab(client, dorm, "Пустой источник")
    assert (
        client.post(
            f"/api/dormitories/{dorm}/tabs/{source['id']}/table",
            json={"columns": [{"name": "Сведения", "kind": "text"}]},
        ).status_code
        == 201
    )
    data = state(
        table(
            "work",
            "Количество",
            [
                column(
                    "count",
                    "Записей",
                    rule=link(f"dorm:{dorm}:{source['table_key']}", "", operation="count"),
                )
            ],
            [],
        )
    )
    saved = client.put(BASE, json={"revision": 0, "state": data})
    assert saved.status_code == 200, saved.text
    assert client.delete(f"/api/dormitories/{dorm}/tabs/{source['id']}").status_code == 409


def test_dormitory_calendar_reads_selected_row_days_and_guards_deletion(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    source = create_calendar(
        client, dorm, table_format="calendar", period_mode="month", clear_list=True
    )
    base = f"/api/dormitories/{dorm}/tabs/{source['id']}"
    first = client.post(f"{base}/rows").json()["id"]
    other = client.post(f"{base}/rows").json()["id"]
    for row, amount in [(first, "8"), (other, "100")]:
        response = client.put(f"{base}/rows/{row}/days/2026-11-02", json={"value": amount})
        assert response.status_code == 200, response.text
    assert (
        client.put(f"{base}/rows/{first}/days/2026-11-03", json={"value": "6"}).status_code == 200
    )
    source_id = f"dorm:{dorm}:{source['table_key']}"
    metadata = next(
        s for s in client.get(f"{BASE}/sources").json()["sources"] if s["id"] == source_id
    )
    assert metadata["kind"] == "calendar"
    assert {r["id"] for r in metadata["rows"]} == {str(first), str(other)}
    data = state(
        table(
            "work",
            "Часы",
            [
                column(
                    "hours",
                    "Итого",
                    rule=link(source_id, "$value", sourceRowId=str(first), dateField="$date"),
                )
            ],
            [{"id": "row", "values": {}}],
        )
    )
    result = client.post(
        f"{BASE}/evaluate",
        json={"state": data, "tabId": "work", "from": "2026-11-02", "to": "2026-11-03"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["columns"]["row"]["hours"] == {"value": 14}
    saved = client.put(BASE, json={"revision": 0, "state": data})
    assert saved.status_code == 200, saved.text
    assert client.delete(f"{base}/rows/{first}").status_code == 409
    assert client.delete(f"{base}/rows/{other}").status_code == 204
    assert client.post(f"{base}/clear").status_code == 409
    remaining = client.get(f"{base}/rows").json()
    assert len(remaining) == 1 and remaining[0]["calendar_values"]["2026-11-02"] == "8"


def test_real_employee_links_survive_existing_card_merge(
    client: TestClient, db_session: Session
) -> None:
    user = sign_in(client, db_session)
    dorm = create_dormitory(client)
    source = create_person(
        client, dorm, fields={"full_name": "Иванов Иван", "phone": "+7 912 000 00 01"}
    )["employee_id"]
    target = create_person(
        client, dorm, fields={"full_name": "Иванов Иван Иванович", "phone": "+7 912 000 00 01"}
    )["employee_id"]
    match = {"sourceField": "$employee", "localColumnId": "person"}
    data = state(
        table(
            "work",
            "Контакты",
            [
                column("person", "Сотрудник", "employee"),
                column(
                    "phone",
                    "Телефон",
                    "text",
                    rule=link("people", "phone", operation="lookup", match=match),
                ),
                column(
                    "identity",
                    "Карточка",
                    "employee",
                    rule=link("people", "$employee", operation="lookup", match=match),
                ),
            ],
            [{"id": "row", "values": {"person": source}}],
        )
    )
    assert client.put(BASE, json={"revision": 0, "state": data}).status_code == 200
    legacy_merge(db_session, source, target, user.id)
    result = client.post(f"{BASE}/evaluate", json={"state": data, "tabId": "work"})
    assert result.status_code == 200, result.text
    assert result.json()["columns"]["row"] == {
        "phone": {"value": "+7 912 000 00 01"},
        "identity": {"value": target},
    }
    saved = client.put(BASE, json={"revision": 1, "state": data})
    assert saved.status_code == 200, saved.text
    assert saved.json()["state"]["tabs"][0]["rows"][0]["values"]["person"] == source


def test_real_arrival_calendar_filters_dormitory_and_refreshes_after_change(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client, "Основное")
    other = create_dormitory(client, "Другое")
    first = create_arrival(client, dorm, "2026-11-02", 12)
    create_arrival(client, dorm, "2026-11-03", 4)
    create_arrival(client, other, "2026-11-02", 99)
    calendar = table(
        "work",
        "Заезды по дням",
        [column("label", "Показатель", "text")],
        [
            {
                "id": "expected",
                "values": {"label": "Ожидается"},
                "rule": link(
                    "arrivals",
                    "count",
                    dateField="date",
                    filters=[{"field": "dormitory", "operator": "equals", "value": "Основное"}],
                ),
            }
        ],
    )
    calendar["tableOptions"] = {"table_format": "calendar", "period_mode": "range"}
    data = state(calendar)

    def values() -> dict[str, Any]:
        result = client.post(
            f"{BASE}/evaluate",
            json={"state": data, "tabId": "work", "from": "2026-11-02", "to": "2026-11-03"},
        )
        assert result.status_code == 200, result.text
        return result.json()["days"]["expected"]

    assert values() == {"2026-11-02": {"value": 12}, "2026-11-03": {"value": 4}}
    updated = client.put(
        f"/api/personnel/arrivals/{first['id']}",
        json={"dormitory_id": dorm, "date": "2026-11-02", "count": 15, "revision": 0},
    )
    assert updated.status_code == 200, updated.text
    assert values()["2026-11-02"] == {"value": 15}
