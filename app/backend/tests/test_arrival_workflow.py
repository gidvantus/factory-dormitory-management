"""Реальные API: независимые отметки, перенос, повторные запросы и смена решения."""

from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.arrival_plans import report_arrivals
from app.models.arrival_plan import ArrivalPlan
from app.models.personnel import Employee, EmployeeEvent
from app.models.resident import Resident
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
    assert saved["people"] == [plan["people"][1]]
    assert saved["count"] == 1
    assert plan["people"][0]["id"] not in saved["workflow"]
    destination = {"person_id": target["people"][-1]["id"]}
    origin = target["workflow"][destination["person_id"]]["origin"]
    assert origin["date"] == plan["date"]
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
    undo = client.post(url(plan, action="undo-move"), json={"revision": saved["revision"]})
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
    assert client.post(url(plan, action="undo-move"), json={"revision": 1}).status_code == 409
    assert client.delete(f"{API}/{target['id']}?revision={target['revision']}").status_code == 409
    replacement = {
        "dormitory_id": source["dormitory_id"],
        "date": source["date"],
        "count": 1,
        "people": [plan["people"][1]],
        "settings_revision": 0,
        "revision": source["revision"],
        "custom_values": source["custom_values"],
    }
    assert client.put(f"{API}/{source['id']}", json=replacement).status_code == 200


@pytest.mark.parametrize("first", ["arrived", "no_show"])
def test_change_status_returns_three_choices_and_allows_a_new_decision(
    client: TestClient, db_session: Session, first: str
) -> None:
    plan = prepare(client, db_session)
    original = plan
    plan = marked(client, plan, first)
    assert plan["workflow"][plan["people"][0]["id"]]["status"] == first
    other = "no_show" if first == "arrived" else "arrived"
    assert marked_error(client, plan, other) == 409
    assert (
        client.post(
            url(plan), json={"revision": original["revision"], "status": "expected"}
        ).status_code
        == 409
    )
    plan = marked(client, plan, "expected")
    assert marked(client, plan, "expected") == plan
    plan = marked(client, plan, other)
    assert plan["workflow"][plan["people"][0]["id"]]["status"] == other
    plan = marked(client, plan, "expected")
    moved = client.post(
        url(plan, action="move"), json={"revision": plan["revision"], "date": "2026-11-08"}
    )
    assert moved.status_code == 200, moved.text
    target = moved.json()["plans"][1]
    person = target["people"][0]
    assert target["workflow"][person["id"]]["status"] == "expected"
    assert person["custom_values"] == original["people"][0]["custom_values"]
    assert marked(client, target)["workflow"][person["id"]]["status"] == "arrived"
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 0
    assert db_session.scalar(select(func.count()).select_from(Employee)) == 0
    assert db_session.scalar(select(func.count()).select_from(EmployeeEvent)) == 0


def marked_error(client: TestClient, plan: dict[str, Any], status: str) -> int:
    return client.post(url(plan), json={"revision": plan["revision"], "status": status}).status_code


def test_arrived_person_keeps_personal_fields_editable(
    client: TestClient, db_session: Session
) -> None:
    plan = marked(client, prepare(client, db_session))
    saved = plan
    payload = {
        key: saved[key]
        for key in ("dormitory_id", "date", "count", "people", "custom_values", "revision")
    }
    payload["settings_revision"] = 0
    payload["people"][0]["custom_values"]["shifts"] = "30"
    response = client.put(f"{API}/{plan['id']}", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["people"][0]["custom_values"]["shifts"] == "30"
    assert response.json()["workflow"][plan["people"][0]["id"]]["status"] == "arrived"
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 0


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


def test_settlement_is_unavailable_and_cannot_create_residency(
    client: TestClient, db_session: Session
) -> None:
    plan = marked(client, prepare(client, db_session))
    assert (
        client.post(url(plan, action="settle"), json={"revision": plan["revision"]}).status_code
        == 404
    )
    assert marked_error(client, plan, "settled") == 422
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 0
    assert db_session.scalar(select(func.count()).select_from(Employee)) == 0
    assert client.get(f"{API}/{plan['id']}").json()["revision"] == plan["revision"]


def test_legacy_settlement_preserves_resident_link_and_snapshot(
    client: TestClient, db_session: Session
) -> None:
    plan = marked(client, prepare(client, db_session))
    resident = Resident(
        dormitory_id=plan["dormitory_id"], full_name="Петров Пётр", notes="Ранее заселён"
    )
    db_session.add(resident)
    db_session.flush()
    row = db_session.get(ArrivalPlan, plan["id"])
    assert row
    visit = row.visits[0]
    visit.status = "settled"
    visit.resident = resident
    visit.settlement = {"settlement_date": "2026-10-27", "arrival_values": plan["custom_values"]}
    db_session.commit()
    response = client.get(f"{API}/{plan['id']}")
    assert response.status_code == 200
    saved = response.json()
    legacy = saved["workflow"][plan["people"][0]["id"]]
    assert legacy["status"] == "arrived"
    assert legacy["resident"]["id"] == resident.id
    assert legacy["settlement"] == visit.settlement
    assert saved["revision"] == plan["revision"]
    db_session.refresh(visit)
    assert visit.status == "settled"  # Чтение не переписывает старые данные.
    reset = marked(client, saved, "expected")
    assert reset["workflow"][plan["people"][0]["id"]]["settlement"] == visit.settlement
    db_session.refresh(resident)
    assert resident.notes == "Ранее заселён"
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

    assert (
        client.post(url(saved, action="settle"), json={"revision": saved["revision"]}).status_code
        == 404
    )


def test_edit_source_after_move_preserves_hidden_receipt_and_allows_move_back(
    client: TestClient, db_session: Session
) -> None:
    plan = prepare(client, db_session)
    source, target = client.post(
        url(plan, action="move"), json={"revision": 0, "date": "2026-10-29"}
    ).json()["plans"]
    payload = {
        key: source[key]
        for key in ("dormitory_id", "date", "count", "people", "custom_values", "revision")
    }
    payload["settings_revision"] = 0
    payload["people"][0]["custom_values"]["shifts"] = "25"
    response = client.put(f"{API}/{source['id']}", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["count"] == 1
    assert response.json()["people"][0]["custom_values"]["shifts"] == "25"
    raw = db_session.get(ArrivalPlan, source["id"])
    assert raw and raw.count == 2 and any(visit.status == "moved" for visit in raw.visits)
    back = client.post(
        url(target, action="move"), json={"revision": target["revision"], "date": plan["date"]}
    )
    assert back.status_code == 200, back.text
    empty, restored = back.json()["plans"]
    assert empty["count"] == 0 and empty["people"] == [] and empty["workflow"] == {}
    assert restored["count"] == 2
    assert {person["id"] for person in restored["people"]} == {
        person["id"] for person in plan["people"]
    }
    returned = restored["workflow"][plan["people"][0]["id"]]
    assert returned["status"] == "expected" and returned["origin"]["date"] == target["date"]
    again = client.post(
        url(restored, action="move"),
        json={"revision": restored["revision"], "date": target["date"]},
    )
    assert again.status_code == 200, again.text
    assert again.json()["plans"][1]["count"] == 1
    assert report_arrivals(
        db_session, plan["dormitory_id"], date(2026, 10, 27), date(2026, 10, 29)
    ) == {date(2026, 10, 27): 1, date(2026, 10, 29): 1}


def test_can_add_people_to_a_day_after_everyone_moved_away(
    client: TestClient, db_session: Session
) -> None:
    plan = prepare(client, db_session)
    first = client.post(
        url(plan, action="move"), json={"revision": 0, "date": "2026-10-29"}
    ).json()["plans"][0]
    second = client.post(
        url(first, action="move"), json={"revision": first["revision"], "date": "2026-10-29"}
    )
    assert second.status_code == 200, second.text
    empty = second.json()["plans"][0]
    assert empty["count"] == 0 and empty["people"] == [] and empty["names"] == []
    loaded = client.get(f"{API}/{plan['id']}").json()
    assert loaded["people"] == []
    payload = body(plan["dormitory_id"])
    payload["people"] = payload["people"][:1]
    payload["people"][0]["full_name"] = "Новый человек"
    payload["count"] = 1
    payload["revision"] = empty["revision"]
    response = client.put(f"{API}/{plan['id']}", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["count"] == 1
    assert response.json()["names"] == ["Новый человек"]
    raw = db_session.get(ArrivalPlan, plan["id"])
    assert raw and raw.count == 3 and len(raw.visits) == 2
    assert db_session.scalar(select(func.count()).select_from(Resident)) == 0
