"""Предварительное сравнение, подтверждение потерь и атомарный перевод."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.payment import PaymentEntry
from app.models.resident import Resident
from tests.test_reports import create_dormitory
from tests.test_resident_payments import cell, column, setup


def preview(client: TestClient, source: int, resident: int, target: int) -> dict[str, Any]:
    response = client.post(
        f"/api/dormitories/{source}/residents/{resident}/transfer/preview",
        json={"target_dormitory_id": target, "month": "2026-10-01"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def payload(target: int, plan: dict[str, Any], confirm: bool = False) -> dict[str, Any]:
    return {
        "target_dormitory_id": target,
        "month": "2026-10-01",
        "preview_token": plan["preview_token"],
        "confirm_loss": confirm,
    }


def test_transfer_copies_all_current_fields_remaps_options_and_keeps_payments(
    client: TestClient, db_session: Session
) -> None:
    source, resident = setup(client, db_session)
    target = create_dormitory(client, "Новое")
    custom_values: dict[str, Any] = {}
    for kind, value in [
        ("text", "Примечание"),
        ("number", "12.5"),
        ("date", "2026-10-15"),
        ("checkbox", False),
        ("select", "Есть"),
    ]:
        source_col = column(client, source, "residents", f"Данные {kind}", kind)
        target_col = column(client, target, "residents", f"данные {kind}", kind)
        if kind == "select":
            value = source_col["options"][0]["id"]
            custom_values[str(target_col["id"])] = target_col["options"][0]["id"]
        else:
            custom_values[str(target_col["id"])] = value
        cell(client, source, resident, source_col, value)
    for kind in ("advance", "settlement"):
        assert (
            client.post(
                f"/api/dormitories/{source}/residents/{resident}/payments/{kind}"
            ).status_code
            == 201
        )
    before_payments = [
        (
            row.id,
            row.dormitory_id,
            row.kind,
            row.full_name,
            row.personnel_number,
            row.source_resident_id,
        )
        for row in db_session.scalars(select(PaymentEntry))
    ]
    plan = preview(client, source, resident, target)
    assert not plan["warnings"] and not plan["empty_columns"]
    assert client.get(f"/api/dormitories/{source}/residents?month=2026-10-01").json()["residents"]
    assert not client.get(f"/api/dormitories/{target}/residents?month=2026-10-01").json()[
        "residents"
    ]
    response = client.post(
        f"/api/dormitories/{source}/residents/{resident}/transfer", json=payload(target, plan)
    )
    assert response.status_code == 200, response.text
    moved = response.json()
    assert moved["id"] == resident
    assert moved["personnel_number"] == "123" and moved["full_name"] == "Иванов Иван"
    assert moved["custom_values"] == custom_values
    assert not client.get(f"/api/dormitories/{source}/residents?month=2026-10-01").json()[
        "residents"
    ]
    assert client.get(f"/api/dormitories/{target}/residents?month=2026-10-01").json()[
        "residents"
    ] == [moved]
    assert before_payments == [
        (
            row.id,
            row.dormitory_id,
            row.kind,
            row.full_name,
            row.personnel_number,
            row.source_resident_id,
        )
        for row in db_session.scalars(select(PaymentEntry))
    ]
    assert (
        client.post(
            f"/api/dormitories/{source}/residents/{resident}/transfer", json=payload(target, plan)
        ).status_code
        == 404
    )
    assert len(list(db_session.scalars(select(Resident)))) == 1


def test_missing_deleted_and_mismatched_fields_require_confirmation(
    client: TestClient, db_session: Session
) -> None:
    source, resident = setup(client, db_session)
    target = create_dormitory(client, "Новое")
    targets = client.get(f"/api/dormitories/{target}/tables/residents/columns").json()
    number = next(col for col in targets if col["builtin_key"] == "personnel_number")
    assert (
        client.delete(
            f"/api/dormitories/{target}/tables/residents/columns/{number['id']}"
        ).status_code
        == 204
    )
    source_col = column(client, source, "residents", "Комментарий", "text")
    target_col = column(client, target, "residents", "Комментарий", "number")
    cell(client, source, resident, source_col, "Текст")
    hidden = column(client, source, "residents", "Скрытые данные", "text")
    cell(client, source, resident, hidden, "История")
    assert (
        client.delete(
            f"/api/dormitories/{source}/tables/residents/columns/{hidden['id']}"
        ).status_code
        == 204
    )
    plan = preview(client, source, resident, target)
    assert {warning["column"] for warning in plan["warnings"]} == {
        "Т/н",
        "Комментарий",
        "Скрытые данные",
    }
    url = f"/api/dormitories/{source}/residents/{resident}/transfer"
    assert client.post(url, json=payload(target, plan)).status_code == 409
    original = client.get(f"/api/dormitories/{source}/residents?month=2026-10-01").json()[
        "residents"
    ][0]
    assert original["personnel_number"] == "123"
    assert original["custom_values"][str(source_col["id"])] == "Текст"
    result = client.post(url, json=payload(target, plan, True))
    assert result.status_code == 200, result.text
    assert result.json()["personnel_number"] is None
    assert str(target_col["id"]) not in result.json()["custom_values"]
    assert not result.json()["custom_values"]
    assert result.json()["full_name"] == "Иванов Иван"


@pytest.mark.parametrize(
    "change", ["source_value", "source_column", "target_column", "target_archive"]
)
def test_changes_after_preview_do_not_move_or_lose_the_source(
    client: TestClient, db_session: Session, change: str
) -> None:
    source, resident = setup(client, db_session)
    target = create_dormitory(client, "Новое")
    plan = preview(client, source, resident, target)
    if change == "source_value":
        assert (
            client.patch(
                f"/api/dormitories/{source}/residents/{resident}?month=2026-10-01",
                json={"full_name": "Изменённый человек"},
            ).status_code
            == 200
        )
    elif change == "target_archive":
        assert (
            client.patch(f"/api/dormitories/{target}", json={"is_archived": True}).status_code
            == 200
        )
    else:
        dorm = source if change == "source_column" else target
        column(client, dorm, "residents", "Добавлено после сравнения", "text")
    response = client.post(
        f"/api/dormitories/{source}/residents/{resident}/transfer",
        json=payload(target, plan, True),
    )
    assert response.status_code == 409, response.text
    assert client.get(f"/api/dormitories/{source}/residents?month=2026-10-01").json()["residents"]
    assert not client.get(f"/api/dormitories/{target}/residents?month=2026-10-01").json()[
        "residents"
    ]


@pytest.mark.parametrize("matching_hostel", [True, False])
def test_hostel_is_mapped_by_active_name_or_requires_confirmation(
    client: TestClient, db_session: Session, matching_hostel: bool
) -> None:
    source, resident = setup(client, db_session)
    target = create_dormitory(client, "Новое")
    source_hostel = client.post(
        f"/api/dormitories/{source}/hostels", json={"name": "Хостел 1", "month": "2026-10-01"}
    ).json()["id"]
    target_hostel = client.post(
        f"/api/dormitories/{target}/hostels",
        json={"name": "Хостел 1" if matching_hostel else "Хостел 2", "month": "2026-10-01"},
    ).json()["id"]
    assert (
        client.patch(
            f"/api/dormitories/{source}/residents/{resident}?month=2026-10-01",
            json={"hostel_id": source_hostel},
        ).status_code
        == 200
    )
    plan = preview(client, source, resident, target)
    assert bool(plan["warnings"]) != matching_hostel
    if not matching_hostel:
        assert plan["warnings"][0]["column"] == "Место проживания"
    result = client.post(
        f"/api/dormitories/{source}/residents/{resident}/transfer",
        json=payload(target, plan, not matching_hostel),
    )
    assert result.status_code == 200, result.text
    assert result.json()["hostel_id"] == (target_hostel if matching_hostel else None)


def test_select_missing_option_and_custom_to_builtin_validation_are_reported(
    client: TestClient,
    db_session: Session,
) -> None:
    source, resident = setup(client, db_session)
    target = create_dormitory(client, "Новое")
    selected = column(client, source, "residents", "Статус", "select")
    target_selected = column(client, target, "residents", "Статус", "select")
    cell(client, source, resident, selected, selected["options"][0]["id"])
    target_selected["options"][0]["archived"] = True
    assert (
        client.patch(
            f"/api/dormitories/{target}/tables/residents/columns/{target_selected['id']}",
            json={"name": "Статус", "kind": "select", "options": target_selected["options"]},
        ).status_code
        == 200
    )
    source_columns = client.get(f"/api/dormitories/{source}/tables/residents/columns").json()
    count = next(col for col in source_columns if col["builtin_key"] == "shift_count")
    assert (
        client.patch(
            f"/api/dormitories/{source}/tables/residents/columns/{count['id']}",
            json={"name": "Иное количество", "kind": "number", "options": []},
        ).status_code
        == 200
    )
    custom_count = column(client, source, "residents", "Кол-во смен", "number")
    cell(client, source, resident, custom_count, "1.5")
    plan = preview(client, source, resident, target)
    assert {item["column"] for item in plan["warnings"]} == {
        "Статус",
        "Иное количество",
        "Кол-во смен",
    }
    moved = client.post(
        f"/api/dormitories/{source}/residents/{resident}/transfer", json=payload(target, plan, True)
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["shift_count"] is None
    assert not moved.json()["custom_values"]


def test_preview_auth_scope_duplicate_and_invalid_destination(
    client: TestClient, db_session: Session
) -> None:
    assert (
        client.post(
            "/api/dormitories/1/residents/1/transfer/preview",
            json={"target_dormitory_id": 2, "month": "2026-10-01"},
        ).status_code
        == 401
    )
    source, resident = setup(client, db_session)
    target = create_dormitory(client, "Новое")
    url = f"/api/dormitories/{source}/residents/{resident}/transfer/preview"
    for destination, month, expected in [
        (source, "2026-10-01", 422),
        (99999, "2026-10-01", 404),
        (target, "2026-10-02", 422),
    ]:
        assert (
            client.post(url, json={"target_dormitory_id": destination, "month": month}).status_code
            == expected
        )
    duplicate = client.post(f"/api/dormitories/{target}/residents").json()["id"]
    assert (
        client.patch(
            f"/api/dormitories/{target}/residents/{duplicate}?month=2026-10-01",
            json={"personnel_number": "123"},
        ).status_code
        == 200
    )
    assert (
        client.post(url, json={"target_dormitory_id": target, "month": "2026-10-01"}).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/dormitories/{target}/residents/{resident}/transfer/preview",
            json={"target_dormitory_id": source, "month": "2026-10-01"},
        ).status_code
        == 404
    )
