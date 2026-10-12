"""Связь независимых таблиц, ручная идентификация и сохранность истории."""

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.personnel import Employee, EmployeePlan, EmployeeTask
from app.models.resident import Resident
from app.personnel import today
from tests.conftest import login, sign_in
from tests.test_custom_tabs import create_table, tab
from tests.test_reports import create_dormitory
from tests.test_resident_outflow import move, preview
from tests.test_resident_transfer import payload as transfer_payload
from tests.test_resident_transfer import preview as transfer_preview

API = "/api/personnel"
FIELDS = {
    "full_name": "Семёнов Иван Иванович",
    "personnel_number": "Т-10",
    "phone": "+7 912 000 00 01",
}


def check(client: TestClient, fields: dict[str, Any]) -> dict[str, Any]:
    response = client.post(API + "/check", json=fields)
    assert response.status_code == 200, response.text
    return response.json()


def create(
    client: TestClient,
    dorm: int,
    *,
    fields: dict[str, Any] | None = None,
    employee: str | None = None,
    table: str = "residents",
    values: dict[str, Any] | None = None,
    mode: str = "new",
) -> dict[str, Any]:
    fields = dict(FIELDS if fields is None else fields)
    identity = {
        **fields,
        "mode": "existing" if employee else mode,
        "employee_id": employee,
        "check_token": check(client, fields)["check_token"],
    }
    response = client.post(
        API + "/records",
        json={
            "dormitory_id": dorm,
            "table_key": table,
            "identity": identity,
            "values": values or {},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def workspace(client: TestClient) -> dict[str, Any]:
    response = client.get(API)
    assert response.status_code == 200, response.text
    return response.json()


def test_requires_active_login(client: TestClient, db_session: Session) -> None:
    assert client.get(API).status_code == 401
    sign_in(client, db_session, is_active=False)
    assert client.get(API).status_code == 403


def test_check_precedes_creation_and_same_number_never_auto_merges(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    a, b = create_dormitory(client), create_dormitory(client, "Южное")
    fields = {"full_name": "Семенов Иван Иванович", "phone": "8 (912) 000-00-01"}
    stale = check(client, fields)
    first = create(client, a)
    rejected = client.post(
        API + "/records",
        json={
            "dormitory_id": b,
            "table_key": "residents",
            "identity": {**fields, "mode": "new", "check_token": stale["check_token"]},
        },
    )
    assert rejected.status_code == 409
    candidates = check(client, fields)["candidates"]
    assert candidates[0]["id"] == first["employee_id"]
    assert len(candidates[0]["evidence"]) >= 2
    assert not candidates[0]["differences"]  # отсутствие т/н не считается противоречием
    second = create(client, b, fields={"personnel_number": "Т-10", "full_name": "Петров Пётр"})
    assert second["employee_id"] != first["employee_id"]
    assert len(workspace(client)["employees"]) == 2
    assert len(workspace(client)["matches"]) == 1


def test_explicit_existing_preserves_source_variants_and_deletion_history(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    a, b = create_dormitory(client), create_dormitory(client, "Южное")
    first = create(client, a)
    second = create(
        client,
        b,
        employee=first["employee_id"],
        table="inflow",
        fields={"full_name": "Семенов И. И.", "personnel_number": "Т-10"},
    )
    assert second["employee_id"] == first["employee_id"]
    person = workspace(client)["employees"][0]
    assert len(person["sources"]) == 2
    assert "Семенов И. И." in person["variants"]["full_name"]
    assert person["full_name"] == FIELDS["full_name"]
    assert client.delete(f"/api/dormitories/{a}/residents/{first['row_id']}").status_code == 204
    detail = client.get(f"{API}/employees/{first['employee_id']}").json()
    assert any(
        event["kind"] == "deleted" and event["snapshot"]["full_name"] == FIELDS["full_name"]
        for event in detail["events"]
    )
    assert not workspace(client)["employees"][0]["current"]


def test_blank_rows_do_not_create_people_and_correction_keeps_alias(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    blank = client.post(f"/api/dormitories/{dorm}/residents").json()
    assert client.delete(f"/api/dormitories/{dorm}/residents/{blank['id']}").status_code == 204
    assert workspace(client)["employees"] == []
    row = client.post(f"/api/dormitories/{dorm}/residents").json()
    base = f"/api/dormitories/{dorm}/residents/{row['id']}?month={today().replace(day=1)}"
    response = client.patch(base, json={"full_name": "Семенов Ивна"})
    assert response.status_code == 200, response.text
    employee = response.json()["employee_id"]
    assert client.patch(base, json={"full_name": "Семенов Иван"}).status_code == 200
    person = workspace(client)["employees"][0]
    assert person["id"] == employee and person["identity_status"] == "pending"
    assert person["full_name"] == "Семенов Иван"
    assert set(person["variants"]["full_name"]) == {"Семенов Ивна", "Семенов Иван"}


def test_transfer_outflow_and_reentry_keep_one_identity_and_close_departure_plan(
    client: TestClient, db_session: Session
) -> None:
    user = sign_in(client, db_session)
    a, b = create_dormitory(client), create_dormitory(client, "Южное")
    row = create(
        client,
        a,
        values={
            "shift_start": str(today() - timedelta(days=10)),
            "shift_end": str(today() + timedelta(days=3)),
        },
    )
    employee, resident = row["employee_id"], row["row_id"]
    plan = transfer_preview(client, a, resident, b)
    result = client.post(
        f"/api/dormitories/{a}/residents/{resident}/transfer", json=transfer_payload(b, plan, True)
    )
    assert result.status_code == 200, result.text
    assert result.json()["employee_id"] == employee
    decision = client.put(
        f"{API}/employees/{employee}/decision",
        json={
            "resident_id": resident,
            "status": "departure",
            "date": str(today() + timedelta(days=3)),
        },
    )
    assert decision.status_code == 200, decision.text
    assert workspace(client)["plans"][0]["kind"] == "departure"
    result = move(client, b, resident, preview(client, b, resident))
    assert result.status_code == 201, result.text
    assert result.json()["employee_id"] == employee
    assert db_session.get(Resident, resident) is None
    assert not workspace(client)["plans"] and not workspace(client)["decisions"]
    arrival = client.put(
        f"{API}/employees/{employee}/next-shift",
        json={
            "date": str(today()),
            "end": str(today() + timedelta(days=30)),
            "dormitory_id": a,
            "confirmed": True,
        },
    )
    assert arrival.status_code == 200, arrival.text
    again = create(client, a, employee=employee)
    assert again["employee_id"] == employee
    person = workspace(client)["employees"][0]
    assert person["has_outflow"] and len(person["current"]) == 1
    assert not workspace(client)["plans"]
    detail = client.get(f"{API}/employees/{employee}").json()
    assert {a, b} <= {event["dormitory_id"] for event in detail["events"]}
    assert all(event["actor"] == user.full_name for event in detail["events"])


def test_merge_undo_retains_original_sources_tasks_notes_and_plans(
    client: TestClient, db_session: Session
) -> None:
    user = sign_in(client, db_session)
    dorm = create_dormitory(client)
    a = create(client, dorm)["employee_id"]
    b = create(client, dorm, table="outflow")["employee_id"]
    assert (
        client.post(
            f"{API}/employees/{a}/tasks",
            json={"text": "Позвонить", "due": str(today()), "assignee_id": user.id},
        ).status_code
        == 201
    )
    assert (
        client.post(
            f"{API}/employees/{a}/notes", json={"text": "Проверено по первичному документу"}
        ).status_code
        == 201
    )
    assert (
        client.put(
            f"{API}/employees/{a}/next-shift",
            json={
                "date": str(today() + timedelta(days=60)),
                "end": str(today() + timedelta(days=90)),
                "dormitory_id": dorm,
            },
        ).status_code
        == 200
    )
    pair = workspace(client)["matches"][0]
    merged = client.post(
        API + "/merge",
        json={
            **pair,
            "source_id": a,
            "target_id": b,
            "reason": "Проверены контакты",
            "score": None,
        },
    )
    assert merged.status_code == 422  # API не принимает лишние поля
    merged = client.post(
        API + "/merge",
        json={
            "source_id": a,
            "target_id": b,
            "signature": pair["signature"],
            "reason": "Проверены контакты",
        },
    )
    assert merged.status_code == 200, merged.text
    data = workspace(client)
    assert len(data["employees"]) == 1 and data["tasks"][0]["employee_id"] == b
    assert data["plans"][0]["employee_id"] == b
    assert db_session.scalar(select(EmployeeTask)).employee_id == a
    assert len(client.get(f"{API}/employees/{b}").json()["notes"]) == 1
    operation = merged.json()["merge_id"]
    assert client.post(f"{API}/merges/{operation}/undo").status_code == 200
    data = workspace(client)
    assert len(data["employees"]) == 2 and data["tasks"][0]["employee_id"] == a
    assert db_session.scalar(select(EmployeePlan)).employee_id == a
    assert len(client.get(f"{API}/employees/{a}").json()["notes"]) == 1
    assert not client.get(f"{API}/employees/{b}").json()["notes"]
    assert client.post(f"{API}/merges/{operation}/undo").status_code == 409


def test_separation_reappears_only_after_identity_changes(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    a = create(client, dorm)["employee_id"]
    b = create(client, dorm)["employee_id"]
    pair = workspace(client)["matches"][0]
    payload = {
        "source_id": a,
        "target_id": b,
        "signature": pair["signature"],
        "reason": "Разные сотрудники",
    }
    assert client.post(API + "/separate", json=payload).status_code == 200
    assert not workspace(client)["matches"]
    assert (
        client.patch(f"{API}/employees/{a}", json={"phone": "+7 912 000 00 02"}).status_code == 200
    )
    assert len(workspace(client)["matches"]) == 1
    assert client.post(API + "/merge", json=payload).status_code == 409


def test_extend_writes_source_and_rejects_overlap(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    end = today() + timedelta(days=3)
    row = create(
        client,
        dorm,
        values={"shift_start": str(today() - timedelta(days=5)), "shift_end": str(end)},
    )
    employee = row["employee_id"]
    decision = {
        "resident_id": row["row_id"],
        "status": "extend",
        "date": str(end + timedelta(days=5)),
    }
    assert client.put(f"{API}/employees/{employee}/decision", json=decision).status_code == 200
    assert db_session.get(Resident, row["row_id"]).shift_end == end + timedelta(days=5)
    assert (
        client.put(
            f"{API}/employees/{employee}/next-shift", json={"date": str(end), "dormitory_id": dorm}
        ).status_code
        == 422
    )
    assert (
        client.put(
            f"{API}/employees/{employee}/next-shift",
            json={
                "date": str(end + timedelta(days=10)),
                "end": str(end + timedelta(days=40)),
                "dormitory_id": dorm,
            },
        ).status_code
        == 200
    )
    decision["date"] = str(end + timedelta(days=15))
    assert client.put(f"{API}/employees/{employee}/decision", json=decision).status_code == 409
    assert db_session.get(Resident, row["row_id"]).shift_end == end + timedelta(days=5)


def test_preferences_are_personal_and_use_revision_check(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session, email="first@example.com")
    dorm = create_dormitory(client)
    employee = create(client, dorm)["employee_id"]
    prefs = {"revision": 0, "blocks": [], "lists": [], "favorites": [employee]}
    response = client.put(API + "/preferences", json=prefs)
    assert response.status_code == 200, response.text
    assert client.put(API + "/preferences", json=prefs).status_code == 409
    sign_in(client, db_session, email="second@example.com")
    assert workspace(client)["preferences"]["revision"] == 0
    assert workspace(client)["preferences"]["favorites"] == []
    assert workspace(client)["employees"][0]["id"] == employee
    assert login(client, "first@example.com").status_code == 200
    assert workspace(client)["preferences"]["favorites"] == [employee]


def test_custom_binding_uses_column_id_and_does_not_merge(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    existing = create(client, dorm)["employee_id"]
    item = tab(client, dorm)
    base, table = create_table(client, dorm, item)
    column = next(col for col in client.get(table + "/columns").json() if col["name"] == "ФИО")
    row = client.post(base + "/rows").json()
    assert (
        client.put(
            f"{table}/rows/{row['id']}/cells/{column['id']}", json={"value": FIELDS["full_name"]}
        ).status_code
        == 200
    )
    assert len(workspace(client)["employees"]) == 1
    binding = f"{API}/bindings/{dorm}/{item['table_key']}"
    assert client.put(binding, json={"fields": {"full_name": column["id"]}}).status_code == 200
    people = workspace(client)["employees"]
    assert len(people) == 2 and len(workspace(client)["matches"]) == 1
    other = next(person for person in people if person["id"] != existing)
    assert other["identity_status"] == "pending"
    assert (
        client.patch(
            f"{table}/columns/{column['id']}", json={"name": "Фамилия и имя", "kind": "text"}
        ).status_code
        == 200
    )
    assert client.get(binding).json()["fields"] == {"full_name": column["id"]}
    fields = {"full_name": FIELDS["full_name"]}
    linked = client.post(
        API + "/link",
        json={
            "dormitory_id": dorm,
            "table_key": item["table_key"],
            "row_id": row["id"],
            "identity": {
                **fields,
                "mode": "existing",
                "employee_id": existing,
                "check_token": check(client, fields)["check_token"],
            },
        },
    )
    assert linked.status_code == 200, linked.text
    assert len(workspace(client)["employees"]) == 1
    assert db_session.get(Employee, other["id"]) is not None  # история не стирается физически


def test_relink_residence_keeps_its_departure_decision_with_new_card(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    row = create(client, dorm)
    other = create(client, dorm, table="outflow", fields={"full_name": "Петров Пётр"})
    response = client.put(
        f"{API}/employees/{row['employee_id']}/decision",
        json={
            "resident_id": row["row_id"],
            "status": "departure",
            "date": str(today() + timedelta(days=3)),
        },
    )
    assert response.status_code == 200, response.text
    fields = {"full_name": "Петров Пётр"}
    response = client.post(
        API + "/link",
        json={
            "dormitory_id": dorm,
            "table_key": "residents",
            "row_id": row["row_id"],
            "identity": {
                **fields,
                "mode": "existing",
                "employee_id": other["employee_id"],
                "check_token": check(client, fields)["check_token"],
            },
        },
    )
    assert response.status_code == 200, response.text
    data = workspace(client)
    assert data["decisions"][0]["employee_id"] == other["employee_id"]
    assert data["plans"][0]["employee_id"] == other["employee_id"]


def test_merge_uses_missing_primary_fields_without_changing_them_on_undo(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    source = create(client, dorm)
    target = create(
        client, dorm, table="outflow", fields={"personnel_number": FIELDS["personnel_number"]}
    )
    pair = workspace(client)["matches"][0]
    response = client.post(
        API + "/merge",
        json={
            "source_id": source["employee_id"],
            "target_id": target["employee_id"],
            "signature": pair["signature"],
            "reason": "Проверено",
        },
    )
    assert response.status_code == 200, response.text
    assert workspace(client)["employees"][0]["full_name"] == FIELDS["full_name"]
    assert db_session.get(Employee, target["employee_id"]).full_name is None
    assert client.post(f"{API}/merges/{response.json()['merge_id']}/undo").status_code == 200
    people = workspace(client)["employees"]
    assert (
        next(person for person in people if person["id"] == target["employee_id"])["full_name"]
        is None
    )
