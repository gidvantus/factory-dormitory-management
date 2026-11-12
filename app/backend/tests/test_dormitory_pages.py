"""Страницы новых подвкладок, отчёта и групп хостелов."""

from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.hostel import Hostel, HostelCell
from app.models.report import ReportCell, ReportRow
from app.models.table_column import TableColumn
from tests.conftest import sign_in
from tests.test_reports import create_dormitory

PERIOD = {"from": "2026-11-01", "to": "2026-11-30"}


def test_pagination_for_new_nested_custom_tab(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    parent = CustomTab(dormitory_id=dorm, name="Группа", is_group=True)
    db_session.add(parent)
    db_session.flush()
    tab = CustomTab(dormitory_id=dorm, parent_id=parent.id, name="Список", table_created=True)
    db_session.add(tab)
    db_session.flush()
    column = TableColumn(
        dormitory_id=dorm,
        table_key=tab.table_key,
        name="ФИО",
        kind="text",
        position=0,
    )
    db_session.add(column)
    db_session.flush()
    db_session.add_all(
        [
            CustomTabEntry(
                dormitory_id=dorm, tab_id=tab.id, custom_values={str(column.id): f"Запись {i}"}
            )
            for i in range(1, 103)
        ]
    )
    db_session.commit()
    url = f"/api/dormitories/{dorm}/tabs/{tab.id}/rows"
    first = client.get(url, params={"page": 1}).json()
    assert len(first["rows"]) == 100 and first["total"] == 102
    second = client.get(url, params={"page": 2}).json()
    assert len(second["rows"]) == 2
    assert second["rows"][0]["custom_values"][str(column.id)] == "Запись 101"
    found = client.get(url, params={"page": 1, "q": "запись 102"}).json()
    assert found["total"] == 1
    sorted_page = client.get(
        url, params={"page": 1, "sort_column": column.id, "direction": "descending"}
    ).json()
    assert sorted_page["rows"][0]["custom_values"][str(column.id)] == "Запись 102"


def test_report_formula_uses_input_from_another_page(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    formula = ReportRow(dormitory_id=dorm, name="Итог", position=100, formula="=[Ввод]*2")
    source = ReportRow(dormitory_id=dorm, name="Ввод", position=201)
    db_session.add_all(
        [
            formula,
            source,
            *(
                ReportRow(dormitory_id=dorm, name=f"Строка {i}", position=101 + i)
                for i in range(100)
            ),
        ]
    )
    db_session.flush()
    db_session.add(ReportCell(row_id=source.id, report_date=date(2026, 11, 1), value="5"))
    db_session.commit()
    data = client.get(f"/api/dormitories/{dorm}/report", params={**PERIOD, "page": 1}).json()
    assert len(data["rows"]) == 100
    assert all(row["id"] != source.id for row in data["rows"])
    assert (
        next(row for row in data["rows"] if row["id"] == formula.id)["values"]["2026-11-01"] == "10"
    )
    assert next(row for row in data["outline"] if row["id"] == source.id)["values"] == {}


def test_places_page_keeps_hostel_metrics_together(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    hostels = [
        Hostel(dormitory_id=dorm, name=f"Хостел {i}", active_from_month=date(2026, 11, 1))
        for i in range(1, 12)
    ]
    db_session.add_all(hostels)
    db_session.flush()
    db_session.add(
        HostelCell(
            hostel_id=hostels[-1].id, report_date=date(2026, 11, 1), field="paid_m", value=12
        )
    )
    db_session.commit()
    url = f"/api/dormitories/{dorm}/hostels"
    first = client.get(url, params={**PERIOD, "page": 1}).json()
    assert first["total"] == 11 and len(first["months"][0]["hostels"]) == 10
    second = client.get(url, params={**PERIOD, "page": 2}).json()
    assert len(second["months"][0]["hostels"]) == 1
    assert second["months"][0]["hostels"][0]["values"]["free_m"]["2026-11-01"] == 12
