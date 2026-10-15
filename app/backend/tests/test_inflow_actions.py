"""Приток хранит исходную запись, результат создаётся один раз и с той же личностью."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.resident import Resident
from tests.conftest import sign_in
from tests.test_reports import create_dormitory


def setup(client: TestClient, db: Session) -> tuple[int, int]:
    sign_in(client, db)
    dorm = create_dormitory(client)
    row = client.post(f"/api/dormitories/{dorm}/inflow").json()
    saved = client.patch(
        f"/api/dormitories/{dorm}/inflow/{row['id']}",
        json={
            "full_name": "Иванов Иван",
            "settlement_date": "2026-10-14",
            "shift_count": 30,
            "citizenship": "РФ",
            "notes": "Сведения из притока",
        },
    )
    assert saved.status_code == 200, saved.text
    return dorm, row["id"]


def column(
    client: TestClient,
    dorm: int,
    table: str,
    name: str,
    kind: str,
    options: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    result = client.post(
        f"/api/dormitories/{dorm}/tables/{table}/columns",
        json={
            "name": name,
            "kind": kind,
            "options": options or [],
        },
    )
    assert result.status_code == 201, result.text
    return result.json()


def preview(client: TestClient, dorm: int, row: int, action: str = "settle") -> dict[str, Any]:
    response = client.post(f"/api/dormitories/{dorm}/inflow/{row}/{action}/preview")
    assert response.status_code == 200, response.text
    return response.json()


def process(
    client: TestClient, dorm: int, row: int, action: str, plan: dict[str, Any], **fields: Any
) -> Response:
    return client.post(
        f"/api/dormitories/{dorm}/inflow/{row}/{action}",
        json={
            "preview_token": plan["preview_token"],
            **fields,
        },
    )


def test_settle_keeps_source_identity_and_only_matching_active_columns(
    client: TestClient, db_session: Session
) -> None:
    dorm, row = setup(client, db_session)
    citizenship = column(client, dorm, "residents", "Гражданство", "text")
    source_phone = column(client, dorm, "inflow", "Номер телефона", "text")
    assert (
        client.put(
            f"/api/dormitories/{dorm}/tables/inflow/rows/{row}/cells/{source_phone['id']}",
            json={"value": "+7 (900) 123-45-67"},
        ).status_code
        == 200
    )
    original = db_session.get(PersonnelInflow, row)
    assert original is not None
    employee_id = original.employee_id
    plan = preview(client, dorm, row)
    assert set(plan["matched_columns"]) == {
        "Т/н",
        "ФИО",
        "Кол-во смен",
        "Гражданство",
        "Номер телефона",
    }
    response = process(client, dorm, row, "settle", plan)
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["inflow"]["processed_as"] == "residents"
    assert result["inflow"]["processed_at"]
    db_session.expire_all()
    resident = db_session.get(Resident, result["row_id"])
    kept = db_session.get(PersonnelInflow, row)
    assert resident and kept
    assert resident.employee_id == kept.employee_id == employee_id
    assert resident.full_name == kept.full_name == "Иванов Иван"
    assert resident.shift_count == 30 and resident.phone == "+7 (900) 123-45-67"
    assert resident.custom_values[str(citizenship["id"])] == "РФ"
    assert resident.notes is None and resident.shift_start is None
    assert kept.notes == "Сведения из притока" and kept.settlement_date is not None
    assert kept.settlement_date.isoformat() == "2026-10-14"
    assert kept.processed_row_id == resident.id
    assert process(client, dorm, row, "settle", plan).status_code == 409
    assert process(client, dorm, row, "outflow", plan).status_code == 409
    assert client.delete(f"/api/dormitories/{dorm}/inflow/{row}").status_code == 409
    assert len(list(db_session.scalars(sa.select(Resident)))) == 1
    assert client.delete(f"/api/dormitories/{dorm}/residents/{resident.id}").status_code == 204
    assert process(client, dorm, row, "settle", plan).status_code == 409
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/inflow/{row}", json={"processed_as": None}
        ).status_code
        == 422
    )


def test_outflow_uses_reason_dictionary_date_and_general_report_without_touching_residents(
    client: TestClient, db_session: Session
) -> None:
    dorm, row = setup(client, db_session)
    existing = client.post(f"/api/dormitories/{dorm}/residents").json()["id"]
    plan = preview(client, dorm, row, "outflow")
    assert process(client, dorm, row, "outflow", plan).status_code == 422
    assert process(client, dorm, row, "outflow", plan, reason="Не заехал").status_code == 422
    response = process(
        client, dorm, row, "outflow", plan, reason="  Не   заехал ", departure_date="2026-10-19"
    )
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["inflow"]["processed_as"] == "outflow"
    assert client.delete(f"/api/dormitories/{dorm}/inflow/{row}").status_code == 409
    db_session.expire_all()
    target = db_session.get(PersonnelOutflow, result["row_id"])
    kept = db_session.get(PersonnelInflow, row)
    assert target and kept and target.employee_id == kept.employee_id
    assert target.reason == "Не заехал" and target.departure_date is not None
    assert target.departure_date.isoformat() == "2026-10-19"
    assert target.notes == kept.notes
    assert db_session.get(Resident, existing) is not None
    assert client.get(f"/api/dormitories/{dorm}/outflow/fields").json()["reasons"] == [
        {"value": "Не заехал", "label": "Не заехал"}
    ]
    fields = plan["fields"]
    report = f"/api/dormitories/{dorm}/report"
    response = client.post(
        f"{report}/rows",
        json={
            "name": "Не заехали",
            "link": {
                "table_key": "outflow",
                "column_id": fields["reason_column"]["id"],
                "value": "Не заехал",
                "date_column_id": fields["departure_column"]["id"],
            },
        },
    )
    assert response.status_code == 201, response.text
    assert client.get(f"{report}?from=2026-10-18&to=2026-10-19").json()["rows"][-1]["values"] == {
        "2026-10-18": "0",
        "2026-10-19": "1",
    }


def test_custom_selects_use_target_option_ids_and_outflow_dropdown_is_respected(
    client: TestClient, db_session: Session
) -> None:
    dorm, row = setup(client, db_session)
    source = column(client, dorm, "inflow", "Статус", "select", [{"label": "Проверен"}])
    target = column(client, dorm, "outflow", "Статус", "select", [{"label": "Проверен"}])
    reason = column(client, dorm, "outflow", "Причины", "select", [{"label": "Не заехал"}])
    client.put(
        f"/api/dormitories/{dorm}/tables/inflow/rows/{row}/cells/{source['id']}",
        json={"value": source["options"][0]["id"]},
    )
    plan = preview(client, dorm, row, "outflow")
    assert plan["fields"]["reason_column"]["id"] == reason["id"]
    assert (
        process(
            client, dorm, row, "outflow", plan, reason="Не заехал", departure_date="2026-10-20"
        ).status_code
        == 422
    )
    result = process(
        client,
        dorm,
        row,
        "outflow",
        plan,
        reason=reason["options"][0]["id"],
        departure_date="2026-10-20",
    )
    assert result.status_code == 201, result.text
    db_session.expire_all()
    saved = db_session.get(PersonnelOutflow, result.json()["row_id"])
    assert saved is not None
    assert saved.custom_values[str(target["id"])] == target["options"][0]["id"]
    assert (
        saved.custom_values[str(reason["id"])] == reason["options"][0]["id"]
        and saved.reason == "Не заехал"
    )


@pytest.mark.parametrize("change", ["source", "columns", "archived"])
def test_stale_confirmation_cannot_create_result(
    client: TestClient, db_session: Session, change: str
) -> None:
    dorm, row = setup(client, db_session)
    plan = preview(client, dorm, row)
    if change == "source":
        client.patch(f"/api/dormitories/{dorm}/inflow/{row}", json={"full_name": "Петров Пётр"})
    elif change == "columns":
        column(client, dorm, "residents", "Примечание", "text")
    else:
        columns = client.get(f"/api/dormitories/{dorm}/tables/residents/columns").json()
        name = next(col for col in columns if col["builtin_key"] == "full_name")
        client.delete(f"/api/dormitories/{dorm}/tables/residents/columns/{name['id']}")
    assert process(client, dorm, row, "settle", plan).status_code == 409
    db_session.expire_all()
    assert not list(db_session.scalars(sa.select(Resident)))
    kept = db_session.get(PersonnelInflow, row)
    assert kept is not None and kept.processed_as is None


def test_renamed_builtin_and_archived_columns_are_not_copied(
    client: TestClient, db_session: Session
) -> None:
    dorm, row = setup(client, db_session)
    cols = client.get(f"/api/dormitories/{dorm}/tables/inflow/columns").json()
    name = next(col for col in cols if col["builtin_key"] == "full_name")
    count = next(col for col in cols if col["builtin_key"] == "shift_count")
    client.patch(
        f"/api/dormitories/{dorm}/tables/inflow/columns/{name['id']}",
        json={"name": "Имя работника", "kind": "text", "options": []},
    )
    client.delete(f"/api/dormitories/{dorm}/tables/inflow/columns/{count['id']}")
    result = process(client, dorm, row, "settle", preview(client, dorm, row))
    assert result.status_code == 201
    saved = db_session.get(Resident, result.json()["row_id"])
    assert saved and saved.full_name is None and saved.shift_count is None and saved.employee_id


def test_missing_outflow_fields_are_optional_and_other_dormitory_is_rejected(
    client: TestClient, db_session: Session
) -> None:
    dorm, row = setup(client, db_session)
    cols = client.get(f"/api/dormitories/{dorm}/tables/outflow/columns").json()
    for col in cols:
        if col["builtin_key"] in ("reason", "departure_date"):
            client.delete(f"/api/dormitories/{dorm}/tables/outflow/columns/{col['id']}")
    plan = preview(client, dorm, row, "outflow")
    assert plan["fields"] == {"reason_column": None, "departure_column": None, "reasons": []}
    other = create_dormitory(client, "Другое")
    assert process(client, other, row, "outflow", plan).status_code == 404
    result = process(client, dorm, row, "outflow", plan)
    assert result.status_code == 201


def test_employee_already_residing_cannot_be_settled_again(
    client: TestClient, db_session: Session
) -> None:
    dorm, row = setup(client, db_session)
    other = create_dormitory(client, "Другое")
    source = db_session.get(PersonnelInflow, row)
    assert source is not None
    db_session.add(Resident(dormitory_id=other, employee_id=source.employee_id))
    db_session.commit()
    result = process(client, dorm, row, "settle", preview(client, dorm, row))
    assert result.status_code == 409 and "уже есть" in result.text
    db_session.expire_all()
    assert source.processed_as is None


def test_new_rows_are_first_and_existing_inflow_columns_get_actions(
    client: TestClient, db_session: Session
) -> None:
    dorm, _row = setup(client, db_session)
    for table in ("inflow", "outflow", "residents"):
        first = client.post(f"/api/dormitories/{dorm}/{table}").json()["id"]
        last = client.post(f"/api/dormitories/{dorm}/{table}").json()["id"]
        query = "month=2026-10-01" if table == "residents" else "from=2026-10-01&to=2026-10-31"
        result = client.get(f"/api/dormitories/{dorm}/{table}?{query}").json()
        values = result["residents"] if table == "residents" else result
        assert [entry["id"] for entry in values][:2] == [last, first]
    cols = client.get(f"/api/dormitories/{dorm}/tables/inflow/columns").json()
    action = next(col for col in cols if col["builtin_key"] == "action_check_in")
    client.delete(f"/api/dormitories/{dorm}/tables/inflow/columns/{action['id']}")
    again = client.get(f"/api/dormitories/{dorm}/tables/inflow/columns").json()
    assert len([col for col in again if col["builtin_key"] == "action_check_in"]) == 1
    assert next(col for col in again if col["id"] == action["id"])["archived"]


def test_migration_keeps_existing_inflow_values() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0036_inflow_actions.py"
    spec = spec_from_file_location("inflow_actions_migration", path)
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
            sa.text(
                "SELECT full_name, processed_as, processed_row_id, processed_at "
                "FROM personnel_inflow"
            )
        ).one() == ("Иванов Иван", None, None, None)
