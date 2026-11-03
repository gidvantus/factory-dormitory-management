"""Реальные API: независимые отметки, перенос, повторные запросы и проживание."""

from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.arrival_plans import report_arrivals
from app.models.arrival_plan import ArrivalPlan
from app.models.hostel import Hostel
from app.models.personnel import Employee, EmployeeEvent, EmployeePlan
from app.models.resident import Resident
from app.personnel import today
from tests.conftest import sign_in
from tests.test_arrival_fields import API, body
from tests.test_reports import create_dormitory


def prepare(client: TestClient, db: Session) -> dict[str, Any]:
    sign_in(client, db)
    payload = body(create_dormitory(client))
    payload["people"][0]["full_name"] = "Петров Пётр"
    response = client.post(API, json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def url(plan: dict[str, Any], person: int = 0, action: str = "status") -> str:
    return f"{API}/{plan['id']}/people/{plan['people'][person]['id']}/{action}"


def marked(
    client: TestClient, plan: dict[str, Any], status: str = "arrived", person: int = 0
) -> dict[str, Any]:
    response = client.post(url(plan, person), json={"revision": plan["revision"], "status": status})
    assert response.status_code == 200, response.text
    return response.json()["plans"][0]


def settlement(client: TestClient, db: Session, plan: dict[str, Any]) -> dict[str, Any]:
    hostel = Hostel(
        dormitory_id=plan["dormitory_id"], name="Корпус А", active_from_month=date(2026, 1, 1)
    )
    db.add(hostel)
    db.commit()
    identity = {
        "full_name": plan["people"][0]["full_name"],
        "phone": None,
        "personnel_number": "0041",
    }
    checked = client.post("/api/personnel/check", json=identity).json()
    return {
        "revision": plan["revision"],
        "identity": {
            **identity,
            "mode": "new",
            "employee_id": None,
            "check_token": checked["check_token"],
        },
        "hostel_id": hostel.id,
        "settlement_date": "2026-10-27",
        "shift_start": "2026-10-28",
        "shift_end": None,
        "shift_count": 15,
    }


def test_marks_are_independent_and_do_not_create_residency(
    client: TestClient, db_session: Session
) -> None:
    plan = prepare(client, db_session)
    saved = marked(client, plan)
    assert list(saved["workflow"]) == [plan["people"][0]["id"]]
    assert saved["workflow"][plan["people"][0]["id"]]["status"] == "arrived"
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 0
    assert marked(client, plan) == saved  # Повтор того же запроса не меняет историю.
    failed = client.post(url(plan, 1), json={"revision": 0, "status": "no_show"})
    assert failed.status_code == 409
    saved = marked(client, saved, "no_show", 1)
    assert [visit["status"] for visit in saved["workflow"].values()] == ["arrived", "no_show"]
    saved = marked(client, saved, "expected", 1)
    assert saved["workflow"][plan["people"][1]["id"]]["status"] == "expected"


@pytest.mark.parametrize("existing", [False, True])
def test_move_preserves_values_merges_and_undoes(
    client: TestClient, db_session: Session, existing: bool
) -> None:
    plan = prepare(client, db_session)
    original_target = None
    if existing:
        payload = body(plan["dormitory_id"])
        payload["date"] = "2026-10-29"
        payload["custom_values"] = {"transport": "Самостоятельно"}
        original_target = client.post(API, json=payload).json()
    payload = {"revision": 0, "date": "2026-10-29"}
    response = client.post(url(plan, action="move"), json=payload)
    assert response.status_code == 200, response.text
    saved, target = response.json()["plans"]
    assert saved["people"] == plan["people"]
    visit = saved["workflow"][plan["people"][0]["id"]]
    assert visit["status"] == "moved"
    destination = visit["destination"]
    assert target["count"] == (3 if existing else 1)
    assert target["people"][-1]["custom_values"] == plan["people"][0]["custom_values"]
    assert target["workflow"][destination["person_id"]]["status"] == "expected"
    assert target["custom_values"] == (
        original_target["custom_values"] if original_target else plan["custom_values"]
    )
    assert client.post(url(plan, action="move"), json=payload).json() == response.json()
    report = report_arrivals(
        db_session, plan["dormitory_id"], date(2026, 10, 27), date(2026, 10, 29)
    )
    assert report[date(2026, 10, 27)] == 1
    undo = client.post(url(saved, action="undo-move"), json={"revision": saved["revision"]})
    assert undo.status_code == 200, undo.text
    assert undo.json()["plans"][0]["workflow"][plan["people"][0]["id"]]["status"] == "expected"
    if existing:
        assert original_target is not None
        assert undo.json()["plans"][1]["people"] == original_target["people"]
    else:
        assert undo.json()["deleted_plan_ids"] == [target["id"]]


def test_cannot_undo_progressed_move_or_destroy_history(
    client: TestClient, db_session: Session
) -> None:
    plan = prepare(client, db_session)
    moved = client.post(url(plan, action="move"), json={"revision": 0, "date": "2026-11-08"}).json()
    source, target = moved["plans"]
    target = marked(client, target)
    assert client.post(url(source, action="undo-move"), json={"revision": 1}).status_code == 409
    assert client.delete(f"{API}/{target['id']}?revision={target['revision']}").status_code == 409
    replacement = {
        "dormitory_id": source["dormitory_id"],
        "date": source["date"],
        "count": 1,
        "people": [source["people"][1]],
        "settings_revision": 0,
        "revision": source["revision"],
        "custom_values": source["custom_values"],
    }
    assert client.put(f"{API}/{source['id']}", json=replacement).status_code == 409


def test_settlement_is_atomic_idempotent_and_keeps_hidden_fields(
    client: TestClient, db_session: Session
) -> None:
    plan = marked(client, prepare(client, db_session))
    payload = settlement(client, db_session, plan)
    response = client.post(url(plan, action="settle"), json=payload)
    assert response.status_code == 200, response.text
    saved = response.json()["plans"][0]
    visit = saved["workflow"][plan["people"][0]["id"]]
    assert visit["status"] == "settled"
    assert visit["settlement"]["arrival_values"]["comment"] == "Встреча в 09:00"
    assert visit["settlement"]["personal_values"]["shifts"] == "15"
    assert visit["settlement"]["settlement_date"] == "2026-10-27"
    assert client.post(url(plan, action="settle"), json=payload).json() == response.json()
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 1
    row = db_session.get(Resident, visit["resident"]["id"])
    assert row and row.employee_id == visit["employee_id"] and row.shift_count == 15
    assert row.personnel_number == "0041"
    residents = client.get(
        f"/api/dormitories/{plan['dormitory_id']}/residents?month=2026-10-01"
    ).json()
    assert residents["residents"][0]["arrival_source"]["plan_id"] == plan["id"]
    assert marked_error(client, saved, "expected") == 409


def marked_error(client: TestClient, plan: dict[str, Any], status: str) -> int:
    return client.post(url(plan), json={"revision": plan["revision"], "status": status}).status_code


def test_archived_source_is_readable_but_cannot_be_changed(
    client: TestClient, db_session: Session
) -> None:
    plan = marked(client, prepare(client, db_session))
    assert (
        client.patch(
            f"/api/dormitories/{plan['dormitory_id']}", json={"is_archived": True}
        ).status_code
        == 200
    )
    source = client.get(f"{API}/{plan['id']}")
    assert source.status_code == 200
    assert source.json()["is_archived"] is True
    assert source.json()["dormitory_name"] == "Северное"
    assert marked_error(client, plan, "expected") == 409


def test_audit_masks_arbitrary_personal_and_shared_snapshot_values() -> None:
    from app.audit import mask

    masked = mask(
        {
            "personal_values": {"custom-id": "Телефон +79000000000"},
            "arrival_values": {"comment-id": "Секретная заметка"},
        }
    )
    assert "79000000000" not in str(masked)
    assert "Секретная заметка" not in str(masked)


def test_requires_arrival_active_hostel_and_valid_dates_without_side_effects(
    client: TestClient, db_session: Session
) -> None:
    plan = prepare(client, db_session)
    payload = settlement(client, db_session, plan)
    assert client.post(url(plan, action="settle"), json=payload).status_code == 409
    plan = marked(client, plan)
    payload["revision"] = plan["revision"]
    for changes in ({"hostel_id": 999999}, {"shift_end": "2026-10-01"}, {"shift_count": -1}):
        assert (
            client.post(url(plan, action="settle"), json={**payload, **changes}).status_code == 422
        )
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 0
    assert db_session.scalar(select(func.count()).select_from(Employee)) == 0


def test_duplicate_number_rolls_back_new_employee_and_preserves_arrival(
    client: TestClient, db_session: Session
) -> None:
    plan = marked(client, prepare(client, db_session))
    payload = settlement(client, db_session, plan)
    db_session.add(Resident(dormitory_id=plan["dormitory_id"], personnel_number="0041"))
    db_session.commit()
    response = client.post(url(plan, action="settle"), json=payload)
    assert response.status_code == 409
    assert db_session.scalar(select(func.count()).select_from(Employee)) == 0
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 1
    saved = client.get(f"{API}/{plan['id']}").json()
    assert saved["revision"] == plan["revision"]
    assert saved["workflow"][plan["people"][0]["id"]]["status"] == "arrived"


def test_existing_identity_and_duplicate_residency_guard(
    client: TestClient, db_session: Session
) -> None:
    plan = marked(client, prepare(client, db_session))
    payload = settlement(client, db_session, plan)
    employee = Employee(full_name="Петров Пётр", personnel_number="0041")
    db_session.add(employee)
    db_session.flush()
    db_session.add(
        EmployeeEvent(
            employee_id=employee.id,
            dormitory_id=plan["dormitory_id"],
            kind="identity",
            title="Карточка",
            happened_on=date(2026, 10, 1),
            snapshot={},
        )
    )
    db_session.commit()
    db_session.add(
        EmployeePlan(
            employee_id=employee.id, dormitory_id=plan["dormitory_id"], kind="arrival", date=today()
        )
    )
    db_session.commit()
    payload["identity"].update(mode="existing", employee_id=employee.id)
    checked = client.post(
        "/api/personnel/check",
        json={key: payload["identity"][key] for key in ("full_name", "phone", "personnel_number")},
    ).json()
    payload["identity"]["check_token"] = checked["check_token"]
    response = client.post(url(plan, action="settle"), json=payload)
    assert response.status_code == 200, response.text
    assert (
        response.json()["plans"][0]["workflow"][plan["people"][0]["id"]]["employee_id"]
        == employee.id
    )
    assert db_session.scalar(select(func.count()).select_from(EmployeePlan)) == 0
    second = body(plan["dormitory_id"])
    second["date"] = "2026-11-01"
    second["people"][0]["full_name"] = "Петров Пётр"
    another = marked(client, client.post(API, json=second).json())
    payload["revision"] = another["revision"]
    assert client.post(url(another, action="settle"), json=payload).status_code == 409
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 1


def test_legacy_people_keep_stable_ids_and_other_organizations_cannot_change_them(
    client: TestClient, db_session: Session
) -> None:
    plan = prepare(client, db_session)
    row = db_session.get(ArrivalPlan, plan["id"])
    assert row
    row.people = None
    db_session.commit()
    legacy = client.get(f"{API}/{plan['id']}").json()
    saved = marked(client, legacy)
    assert saved["people"][0]["id"] == legacy["people"][0]["id"]
    client.post("/api/auth/logout")
    sign_in(client, db_session, email="other-workflow@example.com")
    assert client.get(f"{API}/{plan['id']}").status_code == 404
    assert (
        client.post(
            url(saved), json={"revision": saved["revision"], "status": "expected"}
        ).status_code
        == 404
    )
    assert (
        client.post(
            url(saved, action="move"), json={"revision": saved["revision"], "date": "2026-11-01"}
        ).status_code
        == 404
    )
