from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from sqlalchemy.orm import Session

from app.models.personnel import Employee
from app.models.resident import Resident
from app.models.table_column import TableColumn
from app.table_data import ensure_columns
from tests.conftest import sign_in
from tests.test_reports import create_dormitory


def test_selected_workbook_keeps_text_and_only_requested_people(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    employee = Employee(full_name="=1+1", personnel_number="000123", phone="+79001112233")
    other = Employee(full_name="Не выбран")
    db_session.add_all([employee, other])
    db_session.flush()
    row = Resident(
        dormitory_id=dorm, employee_id=employee.id, full_name=employee.full_name, shift_count=0
    )
    db_session.add_all(
        [
            row,
            Resident(dormitory_id=dorm, employee_id=other.id, full_name=other.full_name),
        ]
    )
    columns = ensure_columns(db_session, dorm, "residents")
    field = next(col for col in columns if col.builtin_key == "full_name")
    shifts = next(col for col in columns if col.builtin_key == "shift_count")
    flag = TableColumn(
        dormitory_id=dorm, table_key="residents", name="Проверен", kind="checkbox", position=100
    )
    db_session.add(flag)
    db_session.flush()
    row.custom_values = {str(flag.id): False}
    db_session.commit()
    response = client.post(
        "/api/personnel/export",
        json={
            "name": "Список для коменданта",
            "employee_ids": [employee.id],
            "columns": [[field.id], [flag.id], [shifts.id]],
        },
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert response.headers["cache-control"] == "no-store"
    sheet = load_workbook(BytesIO(response.content)).active
    assert sheet is not None
    assert sheet.max_row == 3
    assert sheet["A1"].value == "Список для коменданта"
    assert sheet["A3"].value == "=1+1" and sheet["A3"].data_type == "s"
    assert sheet["B3"].value == "000123"
    assert sheet["F3"].value == "+79001112233"
    assert sheet["G3"].value == "=1+1" and sheet["G3"].data_type == "s"
    assert sheet["H3"].value == "Нет"
    assert sheet["I3"].value == 0 and sheet["I3"].data_type == "n"
    assert sheet.freeze_panes == "A3"


def test_export_rejects_unavailable_people_and_columns(
    client: TestClient, db_session: Session
) -> None:
    from uuid import uuid4

    sign_in(client, db_session)
    response = client.post("/api/personnel/export", json={"employee_ids": [str(uuid4())]})
    assert response.status_code == 404
    assert client.post("/api/personnel/export", json={"employee_ids": []}).status_code == 422


def test_planning_list_is_scoped_to_requested_dates_and_does_not_load_employees(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api import personnel

    sign_in(client, db_session)
    dorm = create_dormitory(client)
    for date in ("2026-10-20", "2026-10-27"):
        assert (
            client.post(
                "/api/personnel/arrivals", json={"dormitory_id": dorm, "date": date, "count": 2}
            ).status_code
            == 201
        )

    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("Полный реестр не нужен плану заездов")

    monkeypatch.setattr(personnel, "workspace", forbidden)
    response = client.get("/api/personnel/arrivals?from=2026-10-27&to=2026-11-02")
    assert response.status_code == 200
    data = response.json()
    assert [row["date"] for row in data["arrival_plans"]] == ["2026-10-27"]
    assert "employees" not in data and "source_columns" not in data
    assert "arrival_settings" in data
    assert client.get("/api/personnel/arrivals?from=2026-11-02&to=2026-10-27").status_code == 422
    assert client.get("/api/personnel/arrivals?dormitory_id=2147483647").status_code == 404


def test_export_and_planning_never_include_another_organization(
    client: TestClient, db_session: Session
) -> None:
    from datetime import date

    from app.models.arrival_plan import ArrivalPlan
    from tests.conftest import login

    first = sign_in(client, db_session, email="first-export@example.com")
    own = create_dormitory(client)
    own_employee = Employee(full_name="Свой сотрудник")
    db_session.add(own_employee)
    db_session.flush()
    db_session.add(Resident(dormitory_id=own, employee_id=own_employee.id))
    db_session.commit()
    foreign_user = sign_in(client, db_session, email="second-export@example.com")
    foreign = create_dormitory(client)
    employee = Employee(full_name="Чужой сотрудник")
    db_session.add(employee)
    db_session.flush()
    db_session.add(
        Resident(dormitory_id=foreign, employee_id=employee.id, full_name=employee.full_name)
    )
    db_session.add(ArrivalPlan(dormitory_id=foreign, date=date(2026, 10, 27), count=100, names=[]))
    foreign_columns = ensure_columns(db_session, foreign, "residents")
    foreign_field = next(col for col in foreign_columns if col.builtin_key == "full_name")
    db_session.commit()
    assert login(client, first.email).status_code == 200
    listed = client.get("/api/personnel/arrivals?from=2026-10-27&to=2026-11-02").json()
    assert [d["id"] for d in listed["dormitories"]] == [own]
    assert listed["arrival_plans"] == []
    assert client.get(f"/api/personnel/arrivals?dormitory_id={foreign}").status_code == 404
    assert (
        client.post(
            "/api/personnel/export",
            json={"employee_ids": [employee.id], "columns": [[foreign_field.id]]},
        ).status_code
        == 404
    )
    assert login(client, foreign_user.email).status_code == 200
    assert (
        client.post(
            "/api/personnel/export",
            json={"employee_ids": [employee.id], "columns": [[foreign_field.id]]},
        ).status_code
        == 200
    )
    assert login(client, first.email).status_code == 200
    assert (
        client.post(
            "/api/personnel/export",
            json={"employee_ids": [own_employee.id], "columns": [[foreign_field.id]]},
        ).status_code
        == 404
    )
