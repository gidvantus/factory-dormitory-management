"""Причины, даты и отчёт используют одни исходные данные оттока."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.outflow import PersonnelOutflow
from app.models.outflow_reason import OutflowReason
from app.models.resident import Resident
from tests.test_reports import create_dormitory
from tests.test_resident_outflow import preview
from tests.test_resident_payments import column, setup


def send(
    client: TestClient, dorm: int, resident: int, plan: dict[str, Any], **fields: Any
) -> Response:
    return client.post(
        f"/api/dormitories/{dorm}/residents/{resident}/outflow",
        json={
            "preview_token": plan["preview_token"],
            "confirm_loss": True,
            **fields,
        },
    )


def test_text_reason_is_remembered_after_deletion_and_report_uses_departure_date(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident = setup(client, db_session)
    plan = preview(client, dorm, resident)
    fields = plan["fields"]
    assert fields["reason_column"]["builtin_key"] == "reason"
    result = send(
        client, dorm, resident, plan, reason="  Вахта   закончилась ", departure_date="2026-10-21"
    )
    assert result.status_code == 201, result.text
    row = result.json()
    assert row["reason"] == "Вахта закончилась" and row["departure_date"] == "2026-10-21"
    report = f"/api/dormitories/{dorm}/report"
    linked = client.post(
        f"{report}/rows",
        json={
            "name": "Завершили вахту",
            "link": {
                "table_key": "outflow",
                "column_id": fields["reason_column"]["id"],
                "value": row["reason"],
                "date_column_id": fields["departure_column"]["id"],
            },
        },
    )
    assert linked.status_code == 201, linked.text
    values = client.get(f"{report}?from=2026-10-20&to=2026-10-22").json()["rows"][-1]["values"]
    assert values == {"2026-10-20": "0", "2026-10-21": "1", "2026-10-22": "0"}
    assert client.delete(f"/api/dormitories/{dorm}/outflow/{row['id']}").status_code == 204
    options = client.get(f"/api/dormitories/{dorm}/outflow/fields").json()["reasons"]
    assert options == [{"value": "Вахта закончилась", "label": "Вахта закончилась"}]
    other = create_dormitory(client, "Другое")
    assert client.get(f"/api/dormitories/{other}/outflow/fields").json()["reasons"] == []


def test_configured_dropdown_value_is_written_to_custom_cell_and_report(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident = setup(client, db_session)
    columns = client.get(f"/api/dormitories/{dorm}/tables/outflow/columns").json()
    for key in ("reason", "departure_date"):
        old = next(col for col in columns if col["builtin_key"] == key)
        assert (
            client.delete(f"/api/dormitories/{dorm}/tables/outflow/columns/{old['id']}").status_code
            == 204
        )
    reason = column(client, dorm, "outflow", "Причины", "select")
    date_column = column(client, dorm, "outflow", "Дата выезда", "date")
    plan = preview(client, dorm, resident)
    assert plan["fields"]["reason_column"]["id"] == reason["id"]
    choice = reason["options"][0]
    result = send(client, dorm, resident, plan, reason=choice["id"], departure_date="2026-10-20")
    assert result.status_code == 201, result.text
    row = result.json()
    assert row["reason"] == choice["label"]
    assert row["custom_values"][str(reason["id"])] == choice["id"]
    assert row["custom_values"][str(date_column["id"])] == "2026-10-20"
    report = f"/api/dormitories/{dorm}/report"
    link = client.post(
        f"{report}/rows",
        json={
            "name": "Отток",
            "link": {
                "table_key": "outflow",
                "column_id": reason["id"],
                "value": choice["id"],
                "date_column_id": date_column["id"],
            },
        },
    )
    assert link.status_code == 201, link.text
    assert client.get(f"{report}?from=2026-10-20&to=2026-10-20").json()["rows"][-1]["values"] == {
        "2026-10-20": "1"
    }
    saved = client.put(
        f"/api/dormitories/{dorm}/tables/outflow/rows/{row['id']}/cells/{reason['id']}",
        json={"value": reason["options"][1]["id"]},
    )
    assert saved.status_code == 200
    db_session.expire_all()
    updated = db_session.get(PersonnelOutflow, row["id"])
    assert updated is not None and updated.reason == reason["options"][1]["label"]


@pytest.mark.parametrize("field", ["reason", "departure_date"])
def test_hidden_field_is_not_available_and_cannot_be_written(
    client: TestClient, db_session: Session, field: str
) -> None:
    dorm, resident = setup(client, db_session)
    columns = client.get(f"/api/dormitories/{dorm}/tables/outflow/columns").json()
    target = next(col for col in columns if col["builtin_key"] == field)
    client.delete(f"/api/dormitories/{dorm}/tables/outflow/columns/{target['id']}")
    plan = preview(client, dorm, resident)
    assert plan["fields"]["reason_column" if field == "reason" else "departure_column"] is None
    result = send(
        client, dorm, resident, plan, **{field: "Уволился" if field == "reason" else "2026-10-14"}
    )
    assert result.status_code == 409
    assert db_session.get(Resident, resident) is not None
    assert not list(db_session.scalars(select(PersonnelOutflow)))


def test_manual_table_reasons_are_deduplicated_and_old_values_are_offered(
    client: TestClient, db_session: Session
) -> None:
    dorm, _ = setup(client, db_session)
    row = client.post(f"/api/dormitories/{dorm}/outflow").json()
    for reason in ("Уволился", " уволился "):
        result = client.patch(
            f"/api/dormitories/{dorm}/outflow/{row['id']}", json={"reason": reason}
        )
        assert result.status_code == 200 and result.json()["reason"] == "Уволился"
    assert len(list(db_session.scalars(select(OutflowReason)))) == 1
    db_session.add(PersonnelOutflow(dormitory_id=dorm, reason="Старая причина"))
    db_session.commit()
    options = client.get(f"/api/dormitories/{dorm}/outflow/fields").json()["reasons"]
    assert {option["label"] for option in options} == {"Уволился", "Старая причина"}


def test_stale_dropdown_and_invalid_input_do_not_move_resident(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident = setup(client, db_session)
    reason = column(client, dorm, "outflow", "Причины", "select")
    plan = preview(client, dorm, resident)
    for value in ("неизвестный вариант", "", None):
        assert send(client, dorm, resident, plan, reason=value).status_code == 422
    assert (
        send(
            client,
            dorm,
            resident,
            plan,
            reason=reason["options"][0]["id"],
            departure_date="not-a-date",
        ).status_code
        == 422
    )
    options = reason["options"]
    options[0]["archived"] = True
    client.patch(
        f"/api/dormitories/{dorm}/tables/outflow/columns/{reason['id']}",
        json={"name": "Причины", "kind": "select", "options": options},
    )
    assert send(client, dorm, resident, plan, reason=options[0]["id"]).status_code == 409
    assert db_session.get(Resident, resident) is not None
