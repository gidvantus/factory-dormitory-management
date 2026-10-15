"""Связь независимых таблиц, ручная идентификация и сохранность истории."""

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.personnel import Employee, EmployeeMerge, EmployeePlan
from app.models.resident import Resident
from app.personnel import event, today
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


def legacy_merge(db: Session, source_id: str, target_id: str, actor_id: int) -> str:
    """Состояние базы с объединением, выполненным до удаления вкладки."""
    source, target = db.get(Employee, source_id), db.get(Employee, target_id)
    assert source is not None and target is not None
    source.merged_into_id = target_id
    target.identity_status = "confirmed"
    operation = EmployeeMerge(
        source_id=source_id, target_id=target_id, actor_id=actor_id, reason="Проверены контакты"
    )
    db.add(operation)
    db.flush()
    event(
        db,
        source_id,
        "identity",
        "Карточки связаны в общую историю",
        actor_id,
        snapshot={"merge_id": operation.id, "source_id": source_id, "target_id": target_id},
    )
    db.commit()
    return operation.id


def test_tasks_are_removed_and_employee_notes_remain(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    employee = create(client, create_dormitory(client))["employee_id"]
    assert client.post(f"{API}/employees/{employee}/tasks", json={}).status_code == 404
    assert client.patch(f"{API}/tasks/removed", json={"done": True}).status_code == 404
    paths = client.get("/openapi.json").json()["paths"]
    assert not any(path.startswith(API) and "/tasks" in path for path in paths)
    assert "employee_tasks" not in Employee.metadata.tables
    data = workspace(client)
    assert "tasks" not in data
    assert "users" not in data  # Список ответственных больше не нужен в сводке.
    block = {
        "id": "old-tasks",
        "kind": "tasks",
        "title": "Задачи",
        "scope": [],
        "days": 5,
        "limit": 4,
        "wide": False,
        "saved_list_id": None,
    }
    assert (
        client.put(
            API + "/preferences", json={**data["preferences"], "blocks": [block]}
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"{API}/employees/{employee}/notes", json={"text": "Обсудили следующую вахту"}
        ).status_code
        == 201
    )
    detail = client.get(f"{API}/employees/{employee}").json()
    assert [note["text"] for note in detail["notes"]] == ["Обсудили следующую вахту"]
    assert any(event["kind"] == "note" for event in detail["events"])


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
    assert {
        candidate["id"] for candidate in check(client, {"personnel_number": "Т-10"})["candidates"]
    } == {first["employee_id"], second["employee_id"]}


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
    result = move(client, b, resident, preview(client, b, resident))
    assert result.status_code == 201, result.text
    assert result.json()["employee_id"] == employee
    assert db_session.get(Resident, resident) is None
    assert not workspace(client)["plans"]
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
    assert len(person["current"]) == 1
    assert not workspace(client)["plans"]
    detail = client.get(f"{API}/employees/{employee}").json()
    assert any(event["kind"] == "outflow" for event in detail["events"])
    assert {a, b} <= {event["dormitory_id"] for event in detail["events"]}
    assert all(event["actor"] == user.full_name for event in detail["events"])


def test_existing_merge_undo_retains_original_sources_notes_and_plans(
    client: TestClient, db_session: Session
) -> None:
    user = sign_in(client, db_session)
    dorm = create_dormitory(client)
    a = create(client, dorm)["employee_id"]
    b = create(client, dorm, table="outflow")["employee_id"]
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
    operation = legacy_merge(db_session, a, b, user.id)
    data = workspace(client)
    assert len(data["employees"]) == 1
    assert len(data["employees"][0]["sources"]) == 2
    assert data["plans"][0]["employee_id"] == b
    detail = client.get(f"{API}/employees/{b}").json()
    assert len(detail["notes"]) == 1
    assert detail["merges"][0]["id"] == operation
    assert any(entry["title"] == "Карточки связаны в общую историю" for entry in detail["events"])
    assert [item["id"] for item in check(client, FIELDS)["candidates"]] == [b]
    assert client.post(f"{API}/merges/{operation}/undo").status_code == 200
    data = workspace(client)
    assert len(data["employees"]) == 2
    assert db_session.scalar(select(EmployeePlan)).employee_id == a
    assert len(client.get(f"{API}/employees/{a}").json()["notes"]) == 1
    assert not client.get(f"{API}/employees/{b}").json()["notes"]
    assert client.post(f"{API}/merges/{operation}/undo").status_code == 409


def test_bulk_matches_removed_but_identity_check_remains(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    a = create(client, dorm)["employee_id"]
    b = create(client, dorm)["employee_id"]
    payload = {
        "source_id": a,
        "target_id": b,
        "signature": "a" * 64,
        "reason": "Разные сотрудники",
    }
    assert client.post(API + "/separate", json=payload).status_code == 404
    assert client.post(API + "/merge", json=payload).status_code == 404
    paths = client.get("/openapi.json").json()["paths"]
    assert API + "/merge" not in paths and API + "/separate" not in paths
    data = workspace(client)
    assert "matches" not in data and len(data["employees"]) == 2
    assert {item["id"] for item in check(client, FIELDS)["candidates"]} == {a, b}


def test_decisions_removed_but_residence_dates_and_history_remain_editable(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    end = today() + timedelta(days=3)
    row = create(client, dorm, values={"shift_end": str(end)})
    employee, resident = row["employee_id"], row["row_id"]
    assert (
        client.put(
            f"{API}/employees/{employee}/decision",
            json={
                "resident_id": resident,
                "status": "extend",
                "date": str(end + timedelta(days=5)),
            },
        ).status_code
        == 404
    )
    assert "employee_decisions" not in Employee.metadata.tables
    assert "decisions" not in workspace(client)
    paths = client.get("/openapi.json").json()["paths"]
    assert f"{API}/employees/{{employee_id}}/decision" not in paths
    assert db_session.get(Resident, resident).shift_end == end
    response = client.patch(
        f"/api/dormitories/{dorm}/residents/{resident}?month={today().replace(day=1)}",
        json={"shift_end": str(end + timedelta(days=5))},
    )
    assert response.status_code == 200, response.text
    person = workspace(client)["employees"][0]
    assert person["current"][0]["values"]["shift_end"] == str(end + timedelta(days=5))
    assert person["sources"][0]["row_id"] == resident
    detail = client.get(f"{API}/employees/{employee}").json()
    assert any(
        item["snapshot"].get("shift_end") == str(end + timedelta(days=5))
        for item in detail["events"]
    )
    assert (
        client.put(
            API + "/preferences",
            json={
                "revision": 0,
                "blocks": [],
                "lists": [
                    {
                        "id": "old",
                        "name": "Продления",
                        "column_filters": [
                            {
                                "field": "shift_decision",
                                "operator": "equals",
                                "value": "Продление согласовано",
                            }
                        ],
                    }
                ],
            },
        ).status_code
        == 422
    )


def test_preferences_are_personal_and_use_revision_check(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session, email="first@example.com")
    dorm = create_dormitory(client)
    employee = create(client, dorm)["employee_id"]
    lists = [{"id": "current", "name": "Проживающие", "filter": "current"}]
    prefs = {"revision": 0, "blocks": [], "lists": lists}
    response = client.put(API + "/preferences", json=prefs)
    assert response.status_code == 200, response.text
    assert client.put(API + "/preferences", json=prefs).status_code == 409
    sign_in(client, db_session, email="second@example.com")
    assert workspace(client)["preferences"]["revision"] == 0
    assert workspace(client)["preferences"]["lists"] == []
    assert "favorites" not in workspace(client)["preferences"]
    assert workspace(client)["employees"][0]["id"] == employee
    assert login(client, "first@example.com").status_code == 200
    assert workspace(client)["preferences"]["lists"][0]["id"] == "current"


@pytest.mark.parametrize(
    "removed", ["overdue", "missing", "history", "mine", "returned", "no-phone", "pending"]
)
def test_removed_personnel_filters_cannot_be_saved(
    client: TestClient, db_session: Session, removed: str
) -> None:
    sign_in(client, db_session)
    response = client.put(
        API + "/preferences",
        json={
            "revision": 0,
            "blocks": [],
            "lists": [{"id": "old", "name": "Удалённый фильтр", "filter": removed}],
        },
    )
    assert response.status_code == 422, response.text
    assert workspace(client)["preferences"] == {"revision": 0, "blocks": None, "lists": []}


def test_removed_personnel_blocks_and_favorites_cannot_be_saved(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    for kind in ("outflow", "missing"):
        response = client.put(
            API + "/preferences",
            json={
                "revision": 0,
                "blocks": [{"id": "old", "kind": kind, "title": "Удалённый блок"}],
                "lists": [],
            },
        )
        assert response.status_code == 422, response.text
    assert (
        client.put(
            API + "/preferences", json={"revision": 0, "blocks": [], "lists": [], "favorites": []}
        ).status_code
        == 422
    )


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
    assert len(people) == 2
    assert len(check(client, {"full_name": FIELDS["full_name"]})["candidates"]) == 2
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


def test_relink_residence_keeps_source_and_history_with_new_card(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    row = create(client, dorm)
    other = create(client, dorm, table="outflow", fields={"full_name": "Петров Пётр"})
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
    person = next(item for item in data["employees"] if item["id"] == other["employee_id"])
    assert person["current"][0]["row_id"] == row["row_id"]
    detail = client.get(f"{API}/employees/{other['employee_id']}").json()
    assert any(item["source_table"] == "residents" for item in detail["events"])


def test_existing_merge_uses_missing_primary_fields_without_changing_them_on_undo(
    client: TestClient, db_session: Session
) -> None:
    user = sign_in(client, db_session)
    dorm = create_dormitory(client)
    source = create(client, dorm)
    target = create(
        client, dorm, table="outflow", fields={"personnel_number": FIELDS["personnel_number"]}
    )
    operation = legacy_merge(db_session, source["employee_id"], target["employee_id"], user.id)
    assert workspace(client)["employees"][0]["full_name"] == FIELDS["full_name"]
    assert db_session.get(Employee, target["employee_id"]).full_name is None
    assert client.post(f"{API}/merges/{operation}/undo").status_code == 200
    people = workspace(client)["employees"]
    assert (
        next(person for person in people if person["id"] == target["employee_id"])["full_name"]
        is None
    )
