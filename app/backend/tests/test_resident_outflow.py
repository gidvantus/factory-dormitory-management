"""Сопоставление текущих столбцов, защита подтверждения и удаление выплат при оттоке."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.resident import Resident
from tests.test_reports import create_dormitory
from tests.test_resident_payments import cell, column, setup


def preview(client: TestClient, dorm: int, resident: int) -> dict[str, Any]:
    result = client.post(f"/api/dormitories/{dorm}/residents/{resident}/outflow/preview")
    assert result.status_code == 200, result.text
    return result.json()


def move(client: TestClient, dorm: int, resident: int, plan: dict[str, Any], confirm: bool = True):
    return client.post(
        f"/api/dormitories/{dorm}/residents/{resident}/outflow",
        json={"preview_token": plan["preview_token"], "confirm_loss": confirm},
    )


def register_payments(client: TestClient, dorm: int, resident: int) -> None:
    for kind in ("advance", "settlement"):
        assert (
            client.post(f"/api/dormitories/{dorm}/residents/{resident}/payments/{kind}").status_code
            == 201
        )


def test_current_builtin_and_dynamic_fields_copy_and_payments_are_removed(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident = setup(client)
    expected: dict[str, Any] = {}
    for kind, value in [
        ("text", "Текст"),
        ("number", "12.5"),
        ("date", "2026-10-15"),
        ("checkbox", False),
        ("select", "Есть"),
    ]:
        source = column(client, dorm, "residents", f"Данные {kind}", kind)
        target = column(client, dorm, "outflow", f"данные {kind}", kind)
        if kind == "select":
            value = source["options"][0]["id"]
            expected[str(target["id"])] = target["options"][0]["id"]
        else:
            expected[str(target["id"])] = value
        cell(client, dorm, resident, source, value)
    departure = column(client, dorm, "residents", "Дата выезда", "date")
    cell(client, dorm, resident, departure, "2026-10-09")
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/residents/{resident}?month=2026-10-01",
            json={"shift_start": "2026-10-01", "notes": "Заметка"},
        ).status_code
        == 200
    )
    register_payments(client, dorm, resident)
    plan = preview(client, dorm, resident)
    assert plan["departure_date"] == "2026-10-09"
    assert plan["payments_to_delete"] == {"advance": 1, "settlement": 1}
    assert db_session.get(Resident, resident) is not None
    assert list(db_session.scalars(select(PaymentEntry)))
    response = move(client, dorm, resident, plan)
    assert response.status_code == 201, response.text
    row = response.json()
    assert row["full_name"] == "Иванов Иван" and row["personnel_number"] == "123"
    assert row["shift_start"] == "2026-10-01" and row["departure_date"] == "2026-10-09"
    assert row["additional_info"] == "Заметка" and row["notes"] is None
    assert row["custom_values"] == expected
    assert db_session.get(Resident, resident) is None
    assert not list(db_session.scalars(select(PaymentEntry)))
    assert move(client, dorm, resident, plan).status_code == 404
    assert len(list(db_session.scalars(select(PersonnelOutflow)))) == 1


def test_mismatch_and_hidden_data_require_confirmation_and_do_not_delete_on_cancel(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident = setup(client)
    register_payments(client, dorm, resident)
    columns = client.get(f"/api/dormitories/{dorm}/tables/outflow/columns").json()
    number = next(col for col in columns if col["builtin_key"] == "personnel_number")
    assert (
        client.delete(f"/api/dormitories/{dorm}/tables/outflow/columns/{number['id']}").status_code
        == 204
    )
    mismatch = column(client, dorm, "residents", "Разный тип", "text")
    column(client, dorm, "outflow", "Разный тип", "number")
    cell(client, dorm, resident, mismatch, "Текст")
    hidden = column(client, dorm, "residents", "Скрыто", "text")
    cell(client, dorm, resident, hidden, "Данные")
    assert (
        client.delete(
            f"/api/dormitories/{dorm}/tables/residents/columns/{hidden['id']}"
        ).status_code
        == 204
    )
    plan = preview(client, dorm, resident)
    warnings = {item["column"]: item["reason"] for item in plan["warnings"]}
    assert "Т/н" in warnings and "Разный тип" in warnings and "Скрыто" in warnings
    assert move(client, dorm, resident, plan, False).status_code == 409
    assert db_session.get(Resident, resident) is not None
    assert len(list(db_session.scalars(select(PaymentEntry)))) == 2
    assert not list(db_session.scalars(select(PersonnelOutflow)))
    result = move(client, dorm, resident, plan)
    assert result.status_code == 201 and result.json()["personnel_number"] is None


@pytest.mark.parametrize(
    "change", ["resident", "source_column", "target_column", "payment", "new_payment"]
)
def test_changed_snapshot_never_deletes_unreviewed_data(
    client: TestClient, db_session: Session, change: str
) -> None:
    dorm, resident = setup(client)
    register_payments(client, dorm, resident)
    plan = preview(client, dorm, resident)
    if change == "resident":
        client.patch(
            f"/api/dormitories/{dorm}/residents/{resident}?month=2026-10-01",
            json={"notes": "Новая информация"},
        )
    elif change.endswith("column"):
        column(
            client,
            dorm,
            "residents" if change == "source_column" else "outflow",
            "Новый столбец",
            "text",
        )
    elif change == "payment":
        payment = db_session.scalar(select(PaymentEntry).where(PaymentEntry.kind == "advance"))
        assert payment is not None
        client.patch(
            f"/api/dormitories/{dorm}/payments/advance/{payment.id}",
            json={"advance_amount": "5000"},
        )
    else:
        payment_id = client.post(f"/api/dormitories/{dorm}/payments/advance").json()["id"]
        client.patch(
            f"/api/dormitories/{dorm}/payments/advance/{payment_id}",
            json={"personnel_number": "123"},
        )
    assert move(client, dorm, resident, plan).status_code == 409
    assert db_session.get(Resident, resident) is not None
    assert len(list(db_session.scalars(select(PaymentEntry)))) == (
        3 if change == "new_payment" else 2
    )
    assert not list(db_session.scalars(select(PersonnelOutflow)))
    assert move(client, dorm, resident, preview(client, dorm, resident)).status_code == 201


def test_payment_cleanup_is_scoped_and_includes_manual_numbers_but_not_names(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident = setup(client)
    other = create_dormitory(client, "Другое")
    register_payments(client, dorm, resident)
    manual = PaymentEntry(dormitory_id=dorm, kind="settlement", personnel_number=" 123 ")
    same_name = PaymentEntry(dormitory_id=dorm, kind="advance", full_name="Иванов Иван")
    other_dorm = PaymentEntry(dormitory_id=other, kind="advance", personnel_number="123")
    other_resident = Resident(dormitory_id=dorm, personnel_number="Другой")
    db_session.add_all([manual, same_name, other_dorm, other_resident])
    db_session.flush()
    linked_other = PaymentEntry(
        dormitory_id=dorm,
        kind="advance",
        personnel_number="123",
        source_resident_id=other_resident.id,
    )
    db_session.add(linked_other)
    db_session.commit()
    plan = preview(client, dorm, resident)
    assert plan["payments_to_delete"] == {"advance": 1, "settlement": 2}
    assert move(client, dorm, resident, plan).status_code == 201
    assert {row.id for row in db_session.scalars(select(PaymentEntry))} == {
        same_name.id,
        other_dorm.id,
        linked_other.id,
    }


@pytest.mark.parametrize("date_kind", [None, "text", "date"])
def test_departure_date_is_only_copied_from_matching_date_column(
    client: TestClient, date_kind: str | None
) -> None:
    dorm, resident = setup(client)
    if date_kind:
        departure = column(client, dorm, "residents", "Дата выезда", date_kind)
        cell(client, dorm, resident, departure, "2026-10-16")
    plan = preview(client, dorm, resident)
    expected = "2026-10-16" if date_kind == "date" else None
    assert plan["departure_date"] == expected
    result = move(client, dorm, resident, plan)
    assert result.status_code == 201 and result.json()["departure_date"] == expected


def test_unavailable_select_value_is_reported_and_not_copied(client: TestClient) -> None:
    dorm, resident = setup(client)
    source = column(client, dorm, "residents", "Статус", "select")
    target = column(client, dorm, "outflow", "Статус", "select")
    cell(client, dorm, resident, source, source["options"][0]["id"])
    target["options"][0]["archived"] = True
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/tables/outflow/columns/{target['id']}",
            json={"name": "Статус", "kind": "select", "options": target["options"]},
        ).status_code
        == 200
    )
    plan = preview(client, dorm, resident)
    assert "Статус" in {warning["column"] for warning in plan["warnings"]}
    result = move(client, dorm, resident, plan)
    assert result.status_code == 201 and str(target["id"]) not in result.json()["custom_values"]


def test_outflow_auth_scope_and_payload_validation(client: TestClient) -> None:
    assert client.post("/api/dormitories/1/residents/1/outflow/preview").status_code == 401
    dorm, resident = setup(client)
    other = create_dormitory(client, "Другое")
    assert (
        client.post(f"/api/dormitories/{other}/residents/{resident}/outflow/preview").status_code
        == 404
    )
    assert (
        client.post(
            f"/api/dormitories/{dorm}/residents/{resident}/outflow",
            json={"preview_token": "invalid"},
        ).status_code
        == 422
    )
    plan = preview(client, dorm, resident)
    assert (
        client.post(
            f"/api/dormitories/{dorm}/residents/{resident}/outflow",
            json={"preview_token": plan["preview_token"], "confirm_loss": "true"},
        ).status_code
        == 422
    )
