"""Очистка стандартных списков учитывает настройки и состояние вкладки."""

from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.personnel import EmployeeEvent
from app.models.resident import Resident
from tests.conftest import sign_in
from tests.test_reports import create_dormitory


def test_enable_clear_on_existing_tab_without_touching_other_lists(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client, "Северное")
    other = create_dormitory(client, "Южное")
    base = f"/api/dormitories/{dorm}"
    current = Resident(dormitory_id=dorm, full_name="Иванов Иван")
    other_resident = Resident(dormitory_id=other, full_name="Петров Пётр")
    db_session.add_all([current, other_resident, PersonnelInflow(dormitory_id=dorm)])
    db_session.commit()
    row_id = current.id
    before = client.get(base + "/settings").json()
    clear = base + "/sections/residents/clear"

    assert client.post(clear).status_code == 409
    assert db_session.get(Resident, row_id) is not None
    saved = client.put(
        base + "/settings",
        json={
            "revision": before["revision"],
            "standard_clear_list": {"residents": True, "advance": False},
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] != before["revision"]
    assert client.get(base).json()["standard_clear_list"] == {"residents": True, "advance": False}
    assert client.post(base + "/sections/inflow/clear").status_code == 409
    assert client.post(f"/api/dormitories/{other}/sections/residents/clear").status_code == 409
    assert client.delete(base + "/payments/advance").status_code == 409
    assert client.delete(base + "/payments/settlement").status_code == 204

    assert client.post(clear).status_code == 204
    assert list(db_session.scalars(select(Resident.id))) == [other_resident.id]
    assert db_session.scalar(select(PersonnelInflow.id)) is not None
    assert client.get(base + "/settings").json()["tables"] == before["tables"]
    event = db_session.scalar(
        select(EmployeeEvent).where(
            EmployeeEvent.source_table == "residents", EmployeeEvent.source_id == row_id
        )
    )
    assert event is not None and event.kind == "deleted"
    assert client.post(clear).status_code == 204


def test_clear_movement_preserves_processed_rows_and_respects_hidden_parent(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}"
    processed = PersonnelInflow(dormitory_id=dorm, processed_as="resident")
    evicted = PersonnelOutflow(dormitory_id=dorm, evicted_at=datetime.now(UTC))
    db_session.add_all(
        [
            PersonnelInflow(dormitory_id=dorm),
            processed,
            PersonnelOutflow(dormitory_id=dorm),
            evicted,
        ]
    )
    db_session.commit()
    snapshot = client.get(base + "/settings").json()
    saved = client.put(
        base + "/settings",
        json={
            "revision": snapshot["revision"],
            "sections": {"movement": "hidden"},
            "standard_clear_list": {"inflow": True, "outflow": True},
        },
    )
    assert saved.status_code == 200, saved.text
    assert client.post(base + "/sections/inflow/clear").status_code == 409
    assert client.post(base + "/sections/outflow/clear").status_code == 409
    restored = client.put(
        base + "/settings",
        json={"revision": saved.json()["revision"], "sections": {"movement": "active"}},
    )
    assert restored.status_code == 200, restored.text
    assert client.post(base + "/sections/inflow/clear").status_code == 204
    assert client.post(base + "/sections/outflow/clear").status_code == 204
    assert list(db_session.scalars(select(PersonnelInflow.id))) == [processed.id]
    assert list(db_session.scalars(select(PersonnelOutflow.id))) == [evicted.id]
