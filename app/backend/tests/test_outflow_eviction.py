"""Выселение из оттока: связанные данные, история и защита повторного действия."""

from datetime import date
from decimal import Decimal
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.personnel import Employee, EmployeeEvent
from app.models.resident import Resident
from tests.conftest import sign_in
from tests.test_reports import create_dormitory


def prepare(client: TestClient, db: Session) -> tuple[int, int, int]:
    sign_in(client, db)
    dorm = create_dormitory(client)
    resident_id = client.post(f"/api/dormitories/{dorm}/residents").json()["id"]
    response = client.patch(
        f"/api/dormitories/{dorm}/residents/{resident_id}?month=2026-10-01",
        json={"full_name": "Иванов Иван", "personnel_number": "123"},
    )
    assert response.status_code == 200, response.text
    resident = db.get(Resident, resident_id)
    assert resident and resident.employee_id
    row = PersonnelOutflow(
        dormitory_id=dorm,
        employee_id=resident.employee_id,
        full_name=resident.full_name,
        personnel_number=resident.personnel_number,
        departure_date=date(2026, 10, 14),
        reason="Завершил вахту",
    )
    db.add(row)
    db.commit()
    for kind in ("advance", "settlement"):
        assert (
            client.post(
                f"/api/dormitories/{dorm}/residents/{resident_id}/payments/{kind}"
            ).status_code
            == 201
        )
    return dorm, resident_id, row.id


def token(client: TestClient, dorm: int, row: int) -> str:
    response = client.post(f"/api/dormitories/{dorm}/outflow/{row}/evict/preview")
    assert response.status_code == 200, response.text
    return response.json()["preview_token"]


def test_eviction_removes_related_rows_only_and_keeps_history_and_terminal_status(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident_id, row_id = prepare(client, db_session)
    resident = db_session.get(Resident, resident_id)
    assert resident
    other_dorm = create_dormitory(client, "Другое")
    other_person = Employee(full_name=resident.full_name)
    db_session.add(other_person)
    db_session.flush()
    same_name = Resident(
        dormitory_id=dorm, employee_id=other_person.id, full_name=resident.full_name
    )
    elsewhere = Resident(dormitory_id=other_dorm, employee_id=resident.employee_id)
    db_session.add_all([same_name, elsewhere])
    db_session.flush()
    kept = [
        PaymentEntry(dormitory_id=dorm, kind="advance", source_resident_id=same_name.id),
        PaymentEntry(dormitory_id=other_dorm, kind="settlement", source_resident_id=elsewhere.id),
        PaymentEntry(dormitory_id=dorm, kind="settlement", full_name=resident.full_name),
    ]
    manual = PaymentEntry(dormitory_id=dorm, kind="advance", personnel_number=" 123 ")
    db_session.add_all([*kept, manual])
    db_session.commit()
    base = f"/api/dormitories/{dorm}/outflow/{row_id}"
    preview_token = token(client, dorm, row_id)
    assert db_session.get(Resident, resident_id) is not None
    response = client.post(f"{base}/evict", json={"preview_token": preview_token})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["evicted_at"] and result["reason"] == "Завершил вахту"
    db_session.expire_all()
    assert db_session.get(Resident, resident_id) is None
    assert db_session.get(Resident, same_name.id) and db_session.get(Resident, elsewhere.id)
    assert {item.id for item in db_session.scalars(sa.select(PaymentEntry))} == {
        item.id for item in kept
    }
    events = list(db_session.scalars(sa.select(EmployeeEvent)))
    assert any(item.title == "Проживание завершено · выселение" for item in events)
    assert any(item.title == "Сотрудник выселен" for item in events)
    assert client.post(f"{base}/evict", json={"preview_token": preview_token}).status_code == 409
    assert client.post(f"{base}/evict/preview").status_code == 409
    assert client.delete(base).status_code == 409
    assert client.patch(base, json={"evicted_at": None}).status_code == 422
    listed = client.get(f"/api/dormitories/{dorm}/outflow?from=2026-10-01&to=2026-10-31").json()
    assert listed[0]["evicted_at"] == result["evicted_at"]


@pytest.mark.parametrize("change", ["resident", "payment", "outflow"])
def test_changed_confirmation_deletes_nothing(
    client: TestClient, db_session: Session, change: str
) -> None:
    dorm, resident, row = prepare(client, db_session)
    preview_token = token(client, dorm, row)
    if change == "resident":
        source = db_session.get(Resident, resident)
        assert source
        source.phone = "+79001234567"
    elif change == "payment":
        payment = db_session.scalar(sa.select(PaymentEntry))
        assert payment
        payment.advance_amount = Decimal("999")
    else:
        outflow = db_session.get(PersonnelOutflow, row)
        assert outflow
        outflow.notes = "Изменено"
    db_session.commit()
    response = client.post(
        f"/api/dormitories/{dorm}/outflow/{row}/evict", json={"preview_token": preview_token}
    )
    assert response.status_code == 409, response.text
    db_session.expire_all()
    assert db_session.get(Resident, resident)
    assert len(list(db_session.scalars(sa.select(PaymentEntry)))) == 2
    source_row = db_session.get(PersonnelOutflow, row)
    assert source_row and source_row.evicted_at is None


def test_ambiguous_manual_payment_is_not_deleted(client: TestClient, db_session: Session) -> None:
    dorm, _resident, row = prepare(client, db_session)
    duplicate_number = Resident(
        dormitory_id=dorm, personnel_number="123", full_name="Другой человек"
    )
    manual = PaymentEntry(dormitory_id=dorm, kind="advance", personnel_number="123")
    db_session.add_all([duplicate_number, manual])
    db_session.commit()
    response = client.post(
        f"/api/dormitories/{dorm}/outflow/{row}/evict",
        json={"preview_token": token(client, dorm, row)},
    )
    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert db_session.get(PaymentEntry, manual.id)
    assert db_session.get(Resident, duplicate_number.id)


@pytest.mark.parametrize("section", ["residents", "advance", "settlement"])
def test_read_only_related_sections_prevent_partial_eviction(
    client: TestClient, db_session: Session, section: str
) -> None:
    dorm, resident, row = prepare(client, db_session)
    preview_token = token(client, dorm, row)
    dormitory = db_session.get(Dormitory, dorm)
    assert dormitory
    dormitory.section_states = {section: "hidden"}
    db_session.commit()
    response = client.post(
        f"/api/dormitories/{dorm}/outflow/{row}/evict", json={"preview_token": preview_token}
    )
    assert response.status_code == 409, response.text
    assert db_session.get(Resident, resident)
    assert len(list(db_session.scalars(sa.select(PaymentEntry)))) == 2


def test_can_finish_outflow_after_residence_is_already_removed_and_reject_other_dormitory(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident, row = prepare(client, db_session)
    for payment in db_session.scalars(sa.select(PaymentEntry)):
        db_session.delete(payment)
    db_session.flush()
    item = db_session.get(Resident, resident)
    assert item
    db_session.delete(item)
    db_session.commit()
    preview_token = token(client, dorm, row)
    other = create_dormitory(client, "Другое")
    assert (
        client.post(
            f"/api/dormitories/{other}/outflow/{row}/evict", json={"preview_token": preview_token}
        ).status_code
        == 404
    )
    response = client.post(
        f"/api/dormitories/{dorm}/outflow/{row}/evict", json={"preview_token": preview_token}
    )
    assert response.status_code == 200 and response.json()["evicted_at"]


def test_old_outflow_cannot_evict_new_stay(client: TestClient, db_session: Session) -> None:
    dorm, resident_id, row = prepare(client, db_session)
    resident = db_session.get(Resident, resident_id)
    assert resident
    resident.shift_start = date(2026, 10, 15)
    db_session.commit()
    assert client.post(f"/api/dormitories/{dorm}/outflow/{row}/evict/preview").status_code == 409
    assert db_session.get(Resident, resident_id)


def test_migration_preserves_existing_outflow() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0038_outflow_eviction.py"
    spec = spec_from_file_location("outflow_eviction_migration", path)
    assert spec and spec.loader
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            sa.text("CREATE TABLE personnel_outflow (id INTEGER PRIMARY KEY, reason TEXT)")
        )
        connection.execute(sa.text("INSERT INTO personnel_outflow VALUES (1, 'Завершил вахту')"))
        migration.__dict__["op"] = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        result = connection.execute(sa.text("SELECT reason, evicted_at FROM personnel_outflow"))
        assert result.one() == ("Завершил вахту", None)


def test_migrations_have_one_head() -> None:
    scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
    assert len(scripts.get_heads()) == 1
