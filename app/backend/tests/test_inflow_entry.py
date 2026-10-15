"""Форма по столбцам проживающих, отложенное заселение и изменяемая структура."""

from datetime import date
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.hostel import Hostel
from app.models.inflow import PersonnelInflow
from app.models.personnel import Employee
from app.models.resident import Resident
from tests.conftest import sign_in
from tests.test_inflow_actions import column
from tests.test_reports import create_dormitory


def setup(client: TestClient, db: Session) -> tuple[int, int]:
    sign_in(client, db)
    dorm = create_dormitory(client)
    hostel = Hostel(dormitory_id=dorm, name="Корпус 1", active_from_month=date(2026, 10, 1))
    db.add(hostel)
    db.commit()
    return dorm, hostel.id


def form(client: TestClient, dorm: int) -> dict[str, Any]:
    response = client.get(f"/api/dormitories/{dorm}/inflow/entry-form?month=2026-10-01")
    assert response.status_code == 200, response.text
    return response.json()


def payload(
    client: TestClient,
    definition: dict[str, Any],
    values: dict[str, Any],
    employee: str | None = None,
) -> dict[str, Any]:
    cells = {
        str(col["id"]): values.get(col["builtin_key"] or str(col["id"]))
        for col in definition["columns"]
    }
    identity = {key: values.get(key) for key in ("full_name", "personnel_number", "phone")}
    checked = client.post("/api/personnel/check", json=identity)
    assert checked.status_code == 200, checked.text
    return {
        "month": definition["month"],
        "schema_token": definition["schema_token"],
        "values": cells,
        "identity": {
            **identity,
            "mode": "existing" if employee else "new",
            "employee_id": employee,
            "check_token": checked.json()["check_token"],
        },
    }


def settle(client: TestClient, dorm: int, row: int) -> dict[str, Any]:
    base = f"/api/dormitories/{dorm}/inflow/{row}/settle"
    preview = client.post(base + "/preview")
    assert preview.status_code == 200, preview.text
    result = client.post(base, json={"preview_token": preview.json()["preview_token"]})
    assert result.status_code == 201, result.text
    return result.json()


def test_all_resident_values_survive_creation_reload_and_settlement(
    client: TestClient, db_session: Session
) -> None:
    dorm, hostel = setup(client, db_session)
    checkbox = column(client, dorm, "residents", "Допуск", "checkbox")
    number = column(client, dorm, "residents", "Размер обуви", "number")
    target_select = column(client, dorm, "residents", "Отдел", "select", [{"label": "Цех"}])
    source_select = column(client, dorm, "inflow", "Отдел", "select", [{"label": "Цех"}])
    definition = form(client, dorm)
    values = {
        "full_name": "Иванов Иван",
        "phone": "+7 (900) 123-45-67",
        "gender": "М",
        "hostel_id": hostel,
        "shift_start": "2026-10-15",
        "shift_end": "2026-11-14",
        "shift_count": 30,
        "medical_book": "Есть",
        "notes": "Комната 205",
        str(checkbox["id"]): False,
        str(number["id"]): "42.5",
        str(target_select["id"]): target_select["options"][0]["id"],
    }
    result = client.post(
        f"/api/dormitories/{dorm}/inflow/entries", json=payload(client, definition, values)
    )
    assert result.status_code == 201, result.text
    row = result.json()
    assert row["full_name"] == values["full_name"] and row["shift_count"] == 30
    assert row["notes"] is None  # «Примечание» не совпадает с «Доп. информация»
    assert row["custom_values"][str(source_select["id"])] == source_select["options"][0]["id"]
    assert not list(db_session.scalars(sa.select(Resident)))
    db_session.expire_all()
    stored = db_session.get(PersonnelInflow, row["id"])
    assert stored and stored.resident_values["columns"]
    assert (
        client.get(f"/api/dormitories/{dorm}/inflow?from=2026-10-01&to=2026-10-31").json()[0]["id"]
        == row["id"]
    )
    # Последнее исправление совпадающего поля в притоке важнее первоначального ввода.
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/inflow/{row['id']}", json={"shift_count": 31}
        ).status_code
        == 200
    )
    processed = settle(client, dorm, row["id"])
    db_session.expire_all()
    resident = db_session.get(Resident, processed["row_id"])
    assert resident and resident.employee_id == row["employee_id"]
    assert resident.phone == values["phone"] and resident.hostel_id == hostel
    assert resident.gender == "М" and resident.medical_book == "Есть"
    assert resident.shift_start == date(2026, 10, 15) and resident.shift_end == date(2026, 11, 14)
    assert resident.shift_count == 31 and resident.personnel_number is None
    assert resident.notes == "Комната 205"
    assert resident.custom_values == {
        str(checkbox["id"]): False,
        str(number["id"]): "42.5",
        str(target_select["id"]): target_select["options"][0]["id"],
    }


def test_form_uses_current_columns_order_names_and_active_hostels(
    client: TestClient, db_session: Session
) -> None:
    dorm, _hostel = setup(client, db_session)
    extra = column(client, dorm, "residents", "Новый столбец", "text")
    cols = client.get(f"/api/dormitories/{dorm}/tables/residents/columns").json()
    name = next(col for col in cols if col["builtin_key"] == "full_name")
    number = next(col for col in cols if col["builtin_key"] == "personnel_number")
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/tables/residents/columns/{name['id']}",
            json={"name": "Имя сотрудника", "kind": "text", "options": []},
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"/api/dormitories/{dorm}/tables/residents/columns/{number['id']}"
        ).status_code
        == 204
    )
    other = create_dormitory(client, "Другое")
    db_session.add_all(
        [
            Hostel(
                dormitory_id=dorm,
                name="Закрыт",
                active_from_month=date(2026, 1, 1),
                active_until_month=date(2026, 10, 1),
            ),
            Hostel(dormitory_id=other, name="Чужой", active_from_month=date(2026, 1, 1)),
        ]
    )
    db_session.commit()
    definition = form(client, dorm)
    assert not any(col["archived"] or col["kind"] == "action" for col in definition["columns"])
    assert (
        next(col for col in definition["columns"] if col["id"] == name["id"])["name"]
        == "Имя сотрудника"
    )
    assert any(col["id"] == extra["id"] for col in definition["columns"])
    assert not any(col["id"] == number["id"] for col in definition["columns"])
    assert [col["position"] for col in definition["columns"]] == sorted(
        col["position"] for col in definition["columns"]
    )
    assert [hostel["name"] for hostel in definition["hostels"]] == ["Корпус 1"]


def test_schema_change_during_entry_creates_nothing(
    client: TestClient, db_session: Session
) -> None:
    dorm, _hostel = setup(client, db_session)
    body = payload(client, form(client, dorm), {"full_name": "Иванов Иван"})
    column(client, dorm, "residents", "Новые сведения", "text")
    result = client.post(f"/api/dormitories/{dorm}/inflow/entries", json=body)
    assert result.status_code == 409, result.text
    assert not list(db_session.scalars(sa.select(Employee)))
    assert not list(db_session.scalars(sa.select(PersonnelInflow)))


@pytest.mark.parametrize(
    "values",
    [
        {"phone": "не телефон"},
        {"shift_start": "2026-11-14", "shift_end": "2026-10-15"},
        {"shift_count": -1},
        {"hostel_id": 999},
        {"medical_book": "Другой вариант"},
    ],
)
def test_invalid_values_are_atomic(
    client: TestClient, db_session: Session, values: dict[str, Any]
) -> None:
    dorm, _hostel = setup(client, db_session)
    body = payload(client, form(client, dorm), {"full_name": "Иванов Иван", **values})
    result = client.post(f"/api/dormitories/{dorm}/inflow/entries", json=body)
    assert result.status_code == 422, result.text
    assert not list(db_session.scalars(sa.select(Employee)))
    assert not list(db_session.scalars(sa.select(PersonnelInflow)))


def test_existing_employee_does_not_get_a_second_card(
    client: TestClient, db_session: Session
) -> None:
    dorm, _hostel = setup(client, db_session)
    employee = Employee(full_name="Иванов Иван", identity_status="confirmed")
    db_session.add(employee)
    db_session.commit()
    result = client.post(
        f"/api/dormitories/{dorm}/inflow/entries",
        json=payload(client, form(client, dorm), {"full_name": "Иванов Иван"}, employee.id),
    )
    assert result.status_code == 201, result.text
    assert result.json()["employee_id"] == employee.id
    assert len(list(db_session.scalars(sa.select(Employee)))) == 1


def test_later_column_changes_preserve_renamed_data_and_skip_archived_fields(
    client: TestClient, db_session: Session
) -> None:
    dorm, _hostel = setup(client, db_session)
    room = column(client, dorm, "residents", "Комната", "text")
    old = column(client, dorm, "residents", "Старые данные", "text")
    result = client.post(
        f"/api/dormitories/{dorm}/inflow/entries",
        json=payload(
            client,
            form(client, dorm),
            {"full_name": "Иванов Иван", str(room["id"]): "205", str(old["id"]): "Старое"},
        ),
    )
    assert result.status_code == 201, result.text
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/tables/residents/columns/{room['id']}",
            json={"name": "Номер комнаты", "kind": "text", "options": []},
        ).status_code
        == 200
    )
    assert (
        client.delete(f"/api/dormitories/{dorm}/tables/residents/columns/{old['id']}").status_code
        == 204
    )
    new = column(client, dorm, "residents", "Новые данные", "text")
    processed = settle(client, dorm, result.json()["id"])
    resident = db_session.get(Resident, processed["row_id"])
    assert resident and resident.custom_values[str(room["id"])] == "205"
    assert str(old["id"]) not in resident.custom_values
    assert str(new["id"]) not in resident.custom_values


def test_clearing_matching_inflow_cell_does_not_restore_original_value(
    client: TestClient, db_session: Session
) -> None:
    dorm, _hostel = setup(client, db_session)
    target = column(client, dorm, "residents", "Комната", "text")
    source = column(client, dorm, "inflow", "Комната", "text")
    response = client.post(
        f"/api/dormitories/{dorm}/inflow/entries",
        json=payload(
            client,
            form(client, dorm),
            {"full_name": "Иванов Иван", str(target["id"]): "205"},
        ),
    )
    assert response.status_code == 201, response.text
    row = response.json()["id"]
    cleared = client.put(
        f"/api/dormitories/{dorm}/tables/inflow/rows/{row}/cells/{source['id']}",
        json={"value": None},
    )
    assert cleared.status_code == 200, cleared.text
    processed = settle(client, dorm, row)
    db_session.expire_all()
    resident = db_session.get(Resident, processed["row_id"])
    assert resident and not resident.custom_values.get(str(target["id"]))


def test_migration_keeps_existing_inflow_rows() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0039_inflow_resident_values.py"
    spec = spec_from_file_location("inflow_values_migration", path)
    assert spec and spec.loader
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            sa.text("CREATE TABLE personnel_inflow (id INTEGER PRIMARY KEY, full_name TEXT)")
        )
        connection.execute(sa.text("INSERT INTO personnel_inflow VALUES (1, 'Иванов Иван')"))
        migration.__dict__["op"] = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert connection.execute(
            sa.text("SELECT full_name, resident_values FROM personnel_inflow")
        ).one() == ("Иванов Иван", "{}")
