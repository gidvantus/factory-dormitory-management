"""Запись в выплаты по текущим столбцам, без повторов и с сохранением проживающего."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.payment import PaymentEntry
from app.models.resident import Resident
from tests.test_reports import create_dormitory, sign_in


def setup(client: TestClient) -> tuple[int, int]:
    sign_in(client)
    dorm = create_dormitory(client)
    resident = client.post(f"/api/dormitories/{dorm}/residents").json()["id"]
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/residents/{resident}?month=2026-10-01",
            json={"full_name": "Иванов Иван", "personnel_number": "123"},
        ).status_code
        == 200
    )
    return dorm, resident


def column(client: TestClient, dorm: int, table: str, name: str, kind: str) -> dict[str, Any]:
    result = client.post(
        f"/api/dormitories/{dorm}/tables/{table}/columns",
        json={
            "name": name,
            "kind": kind,
            "options": [{"label": "Есть"}, {"label": "Нет"}] if kind == "select" else [],
        },
    )
    assert result.status_code == 201, result.text
    return result.json()


def cell(client: TestClient, dorm: int, resident: int, col: dict[str, Any], value: Any) -> None:
    assert (
        client.put(
            f"/api/dormitories/{dorm}/tables/residents/rows/{resident}/cells/{col['id']}",
            json={"value": value},
        ).status_code
        == 200
    )


@pytest.mark.parametrize("kind", ["advance", "settlement"])
def test_copies_default_and_dynamic_fields_with_option_mapping(
    client: TestClient, db_session: Session, kind: str
) -> None:
    dorm, resident = setup(client)
    targets: dict[str, dict[str, Any]] = {}
    for data_kind, value in [
        ("text", "Примечание"),
        ("number", "12.5"),
        ("date", "2026-10-15"),
        ("checkbox", False),
        ("select", "Есть"),
    ]:
        source = column(client, dorm, "residents", f"Данные {data_kind}", data_kind)
        target = column(client, dorm, kind, f"данные {data_kind}", data_kind)
        targets[data_kind] = target
        if data_kind == "select":
            value = source["options"][0]["id"]
            assert value != target["options"][0]["id"]
        cell(client, dorm, resident, source, value)
    column(client, dorm, kind, "Только выплаты", "text")
    column(client, dorm, "residents", "Только проживающие", "text")
    result = client.post(f"/api/dormitories/{dorm}/residents/{resident}/payments/{kind}")
    assert result.status_code == 201, result.text
    body = result.json()
    assert body["created"]
    payment = body["payment"]
    assert payment["full_name"] == "Иванов Иван"
    assert payment["personnel_number"] == "123"
    assert payment["advance_amount"] is None and payment["settlement_date"] is None
    assert payment["custom_values"] == {
        str(targets["text"]["id"]): "Примечание",
        str(targets["number"]["id"]): "12.5",
        str(targets["date"]["id"]): "2026-10-15",
        str(targets["checkbox"]["id"]): False,
        str(targets["select"]["id"]): targets["select"]["options"][0]["id"],
    }
    assert len(body["copied_columns"]) == 7
    assert not body["skipped_columns"]
    assert db_session.get(Resident, resident) is not None
    assert db_session.get(PaymentEntry, payment["id"]).source_resident_id == resident


def test_uses_current_names_types_and_archived_columns(client: TestClient) -> None:
    dorm, resident = setup(client)
    source = column(client, dorm, "residents", "Комментарий", "text")
    target = column(client, dorm, "advance", "Комментарий", "text")
    cell(client, dorm, resident, source, "Первый")
    ignored_source = column(client, dorm, "residents", "Удалённое", "text")
    ignored_target = column(client, dorm, "advance", "Удалённое", "text")
    cell(client, dorm, resident, ignored_source, "Не переносить")
    assert (
        client.delete(
            f"/api/dormitories/{dorm}/tables/residents/columns/{ignored_source['id']}"
        ).status_code
        == 204
    )
    wrong = column(client, dorm, "residents", "Другой тип", "number")
    wrong_target = column(client, dorm, "advance", "Другой тип", "text")
    cell(client, dorm, resident, wrong, "5")
    deleted_target = column(client, dorm, "advance", "Неактивный", "text")
    deleted_source = column(client, dorm, "residents", "Неактивный", "text")
    cell(client, dorm, resident, deleted_source, "Не переносить")
    assert (
        client.delete(
            f"/api/dormitories/{dorm}/tables/advance/columns/{deleted_target['id']}"
        ).status_code
        == 204
    )
    register = f"/api/dormitories/{dorm}/residents/{resident}/payments/advance"
    first = client.post(register).json()["payment"]
    assert first["custom_values"] == {str(target["id"]): "Первый"}
    assert str(ignored_target["id"]) not in first["custom_values"]
    assert str(wrong_target["id"]) not in first["custom_values"]
    assert (
        client.delete(f"/api/dormitories/{dorm}/payments/advance/{first['id']}").status_code == 204
    )
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/tables/advance/columns/{target['id']}",
            json={"name": "Переименован", "kind": "text", "options": []},
        ).status_code
        == 200
    )
    second = client.post(register).json()["payment"]
    assert not second["custom_values"]
    assert (
        client.delete(f"/api/dormitories/{dorm}/payments/advance/{second['id']}").status_code == 204
    )
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/tables/residents/columns/{source['id']}",
            json={"name": "Переименован", "kind": "text", "options": []},
        ).status_code
        == 200
    )
    assert client.post(register).json()["payment"]["custom_values"] == {str(target["id"]): "Первый"}


def test_copies_custom_fields_into_standard_date_and_amount_and_reports_incompatible_values(
    client: TestClient,
) -> None:
    dorm, resident = setup(client)
    amount = column(client, dorm, "residents", "Сумма аванса", "number")
    day = column(client, dorm, "residents", "Дата расчёта", "date")
    cell(client, dorm, resident, amount, "1250.50")
    cell(client, dorm, resident, day, "2026-10-15")
    advance_url = f"/api/dormitories/{dorm}/residents/{resident}/payments/advance"
    advance = client.post(advance_url).json()["payment"]
    assert advance["advance_amount"] == "1250.50"
    settlement = client.post(
        f"/api/dormitories/{dorm}/residents/{resident}/payments/settlement"
    ).json()["payment"]
    assert settlement["settlement_date"] == "2026-10-15"
    assert client.delete(f"/api/dormitories/{dorm}/payments/advance").status_code == 204
    cell(client, dorm, resident, amount, "-5")
    source = column(client, dorm, "residents", "Личный статус", "select")
    target = column(client, dorm, "advance", "Личный статус", "select")
    cell(client, dorm, resident, source, source["options"][0]["id"])
    target["options"][0]["archived"] = True
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/tables/advance/columns/{target['id']}",
            json={"name": target["name"], "kind": "select", "options": target["options"]},
        ).status_code
        == 200
    )
    result = client.post(advance_url).json()
    assert result["payment"]["advance_amount"] is None
    assert not result["payment"]["custom_values"]
    assert set(result["skipped_columns"]) == {"Сумма аванса", "Личный статус"}


def test_duplicates_keep_existing_edits_and_allow_registration_after_clear(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident = setup(client)
    url = f"/api/dormitories/{dorm}/residents/{resident}/payments/advance"
    first = client.post(url).json()["payment"]
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/payments/advance/{first['id']}",
            json={"advance_amount": "2000"},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/residents/{resident}?month=2026-10-01",
            json={"personnel_number": "456", "full_name": "Новое имя"},
        ).status_code
        == 200
    )
    repeated = client.post(url)
    assert repeated.status_code == 200
    assert not repeated.json()["created"]
    assert repeated.json()["payment"]["advance_amount"] == "2000.00"
    assert repeated.json()["payment"]["full_name"] == "Иванов Иван"
    assert len(list(db_session.scalars(select(PaymentEntry)))) == 1
    assert (
        client.post(f"/api/dormitories/{dorm}/residents/{resident}/payments/settlement").status_code
        == 201
    )
    other = create_dormitory(client, "Другое")
    assert (
        client.post(f"/api/dormitories/{other}/residents/{resident}/payments/advance").status_code
        == 404
    )
    assert client.delete(f"/api/dormitories/{dorm}/payments/advance").status_code == 204
    assert client.post(url).status_code == 201
    assert len(list(db_session.scalars(select(PaymentEntry)))) == 2


def test_manual_duplicate_empty_sources_and_authentication(client: TestClient) -> None:
    assert client.post("/api/dormitories/1/residents/1/payments/advance").status_code == 401
    dorm, resident = setup(client)
    manual = client.post(f"/api/dormitories/{dorm}/payments/advance").json()["id"]
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/payments/advance/{manual}", json={"personnel_number": "123"}
        ).status_code
        == 200
    )
    result = client.post(f"/api/dormitories/{dorm}/residents/{resident}/payments/advance")
    assert result.status_code == 200
    assert result.json()["payment"]["id"] == manual
    assert not result.json()["created"]
    empty = client.post(f"/api/dormitories/{dorm}/residents").json()["id"]
    assert (
        client.post(f"/api/dormitories/{dorm}/residents/{empty}/payments/advance").status_code
        == 422
    )
    assert (
        client.post(f"/api/dormitories/{dorm}/residents/{resident}/payments/invalid").status_code
        == 422
    )
