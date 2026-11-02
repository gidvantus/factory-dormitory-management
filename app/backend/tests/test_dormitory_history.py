"""История данных: понятный контекст, атомарная запись и неизменяемая вкладка."""

from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.dormitory_history import HistoryRequest, request_context
from app.models.dormitory_history import DormitoryDataEvent
from app.models.hostel import Hostel
from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.resident import Resident
from tests.conftest import sign_in


def create_dorm(client: TestClient, name: str = "Северное") -> int:
    response = client.post("/api/dormitories", json={"name": name, "client_name": "Клиент"})
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def create_archive(client: TestClient, dorm: int) -> dict[str, Any]:
    response = client.post(
        f"/api/dormitories/{dorm}/tabs", json={"name": "Архивные данные", "kind": "archive"}
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


def history(client: TestClient, dorm: int, tab: int, extra: str = "") -> dict[str, Any]:
    today = datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat()
    response = client.get(
        f"/api/dormitories/{dorm}/tabs/{tab}/history?from={today}&to={today}{extra}"
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


def test_data_history_has_source_record_field_before_after_and_author(
    client: TestClient, db_session: Session
) -> None:
    user = sign_in(client, db_session)
    dorm = create_dorm(client)
    archive = create_archive(client, dorm)
    assert archive["kind"] == "archive" and archive["table_created"]
    assert archive["options"]["period_mode"] == "range"
    assert not archive["options"]["add_row"]
    assert history(client, dorm, archive["id"])["items"] == []
    base = f"/api/dormitories/{dorm}/residents"
    resident = client.post(base).json()
    identifier = resident["id"]
    assert (
        client.patch(
            f"{base}/{identifier}?month=2026-11-01",
            json={"full_name": "Петров", "personnel_number": "77"},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"{base}/{identifier}?month=2026-11-01", json={"full_name": "Метров"}
        ).status_code
        == 200
    )
    rows = history(client, dorm, archive["id"])["items"]
    action = rows[0]["action"]
    assert "Проживающие" in action and f"запись №{identifier}" in action
    assert "Т/н 77" in action
    assert "ФИО: «Петров» → «Метров»" in action
    assert rows[0]["author"] == user.full_name
    assert datetime.fromisoformat(rows[0]["date"]).tzinfo is not None
    count = len(rows)
    # Чтение, повторное сохранение прежнего значения и настройки не создают событий данных.
    assert client.get(base + "?month=2026-11-01").status_code == 200
    assert (
        client.patch(
            f"{base}/{identifier}?month=2026-11-01", json={"full_name": "Метров"}
        ).status_code
        == 200
    )
    assert (
        client.patch(f"/api/dormitories/{dorm}", json={"name": "Новое название"}).status_code == 200
    )
    assert len(history(client, dorm, archive["id"])["items"]) == count
    assert client.delete(f"{base}/{identifier}").status_code == 204
    deleted = history(client, dorm, archive["id"])["items"][0]
    assert "удалена запись" in deleted["action"] and "Метров" in deleted["action"]
    assert deleted["author"] == user.full_name


def test_archive_is_read_only_and_ordinary_archive_stays_manual(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dorm(client)
    archive = create_archive(client, dorm)
    key = archive["table_key"]
    assert client.post(f"/api/dormitories/{dorm}/tabs/{archive['id']}/rows").status_code == 409
    assert client.post(f"/api/dormitories/{dorm}/tabs/{archive['id']}/clear").status_code == 409
    assert (
        client.post(
            f"/api/dormitories/{dorm}/tables/{key}/columns", json={"name": "Лишний", "kind": "text"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/dormitories/{dorm}/tabs", json={"name": "Дочерняя", "parent_id": archive["id"]}
        ).status_code
        == 409
    )
    assert client.post(f"/api/dormitories/{dorm}/tables/archive/rows").status_code == 201
    settings = client.get(f"/api/dormitories/{dorm}/settings").json()
    assert (
        client.put(
            f"/api/dormitories/{dorm}/settings",
            json={
                "revision": settings["revision"],
                "tabs": [
                    {"key": key, "name": "Переименованный архив", "options": archive["options"]}
                ],
            },
        ).status_code
        == 200
    )
    assert client.get(f"/api/dormitories/{dorm}/tabs").json()[0]["kind"] == "archive"


def test_history_pagination_scope_and_old_author_name(
    client: TestClient, db_session: Session
) -> None:
    user = sign_in(client, db_session)
    first = create_dorm(client)
    second = create_dorm(client, "Южное")
    archive = create_archive(client, first)
    other = create_archive(client, second)
    for _ in range(3):
        assert client.post(f"/api/dormitories/{first}/residents").status_code == 201
    assert client.post(f"/api/dormitories/{second}/residents").status_code == 201
    page = history(client, first, archive["id"], "&limit=2")
    assert len(page["items"]) == 2 and page["next_cursor"]
    from urllib.parse import quote

    rest = history(client, first, archive["id"], "&limit=2&cursor=" + quote(page["next_cursor"]))
    assert len(rest["items"]) == 1 and rest["next_cursor"] is None
    assert not {row["id"] for row in page["items"]} & {row["id"] for row in rest["items"]}
    assert len(history(client, second, other["id"])["items"]) == 1
    old_name = user.full_name
    user.full_name = "Другое имя автора"
    db_session.commit()
    assert all(row["author"] == old_name for row in history(client, first, archive["id"])["items"])
    before = db_session.scalar(select(func.count()).select_from(DormitoryDataEvent))
    # Перекрёстный tab_id даже в своей организации не читает историю другого общежития.
    today = datetime.now(UTC).date().isoformat()
    assert (
        client.get(
            f"/api/dormitories/{first}/tabs/{other['id']}/history?from={today}&to={today}"
        ).status_code
        == 404
    )
    assert db_session.scalar(select(func.count()).select_from(DormitoryDataEvent)) == before


def test_custom_cells_keep_tab_path_and_original_field_name(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dorm(client)
    archive = create_archive(client, dorm)
    parent = client.post(f"/api/dormitories/{dorm}/tabs", json={"name": "Учёт"}).json()
    child = client.post(
        f"/api/dormitories/{dorm}/tabs", json={"name": "Смены", "parent_id": parent["id"]}
    ).json()
    base = f"/api/dormitories/{dorm}/tabs/{child['id']}"
    created = client.post(base + "/table", json={"columns": [{"name": "Часы", "kind": "number"}]})
    assert created.status_code == 201, created.text
    columns_path = f"/api/dormitories/{dorm}/tables/{child['table_key']}/columns"
    column = client.get(columns_path).json()[0]
    row = client.post(base + "/rows").json()
    cell = (
        f"/api/dormitories/{dorm}/tables/{child['table_key']}/rows/{row['id']}/cells/{column['id']}"
    )
    for value in (1, 2):
        saved = client.put(cell, json={"value": value})
        assert saved.status_code == 200, saved.text
    action = history(client, dorm, archive["id"])["items"][0]["action"]
    assert "Учёт → Смены" in action
    assert f"запись №{row['id']}" in action
    assert "Часы: «1» → «2»" in action
    assert (
        client.patch(
            columns_path + f"/{column['id']}", json={"name": "Отработано", "kind": "number"}
        ).status_code
        == 200
    )
    assert history(client, dorm, archive["id"])["items"][0]["action"] == action


def test_bulk_clear_and_outflow_delete_keep_person_context(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dorm(client)
    archive = create_archive(client, dorm)
    db_session.add_all(
        [
            PaymentEntry(
                dormitory_id=dorm, kind="advance", full_name="Петров", personnel_number="1"
            ),
            PaymentEntry(
                dormitory_id=dorm, kind="advance", full_name="Метров", personnel_number="2"
            ),
        ]
    )
    outflow = PersonnelOutflow(dormitory_id=dorm, full_name="Иванов", personnel_number="3")
    db_session.add(outflow)
    db_session.commit()
    outflow_id = outflow.id
    assert client.delete(f"/api/dormitories/{dorm}/payments/advance").status_code == 204
    assert client.delete(f"/api/dormitories/{dorm}/outflow/{outflow_id}").status_code == 204
    actions = [item["action"] for item in history(client, dorm, archive["id"])["items"]]
    assert len(actions) == 3
    assert any("На аванс" in item and "Петров" in item for item in actions)
    assert any("На аванс" in item and "Метров" in item for item in actions)
    assert any(
        "Отток" in item and "Иванов" in item and "удалена запись" in item for item in actions
    )


def test_failed_transaction_leaves_no_history_and_audit_toggle_does_not_disable_it(
    client: TestClient, db_session: Session, monkeypatch: Any
) -> None:
    user = sign_in(client, db_session)
    dorm = create_dorm(client)
    archive = create_archive(client, dorm)
    resident = Resident(dormitory_id=dorm, full_name="Петров")
    db_session.add(resident)
    db_session.commit()
    identifier = resident.id
    token = request_context.set(
        HistoryRequest("PATCH", user.id, user.active_organization_id, user.full_name)
    )
    try:
        resident.full_name = "Неверное изменение"
        db_session.flush()
        db_session.flush()
        assert db_session.scalar(select(func.count()).select_from(DormitoryDataEvent)) == 1
        db_session.rollback()
    finally:
        request_context.reset(token)
    assert history(client, dorm, archive["id"])["items"] == []
    original = db_session.get(Resident, identifier)
    assert original is not None and original.full_name == "Петров"
    monkeypatch.setattr(get_settings(), "audit_enabled", False)
    response = client.patch(
        f"/api/dormitories/{dorm}/residents/{identifier}?month=2026-11-01",
        json={"full_name": "Метров"},
    )
    assert response.status_code == 200, response.text
    assert "Петров» → «Метров" in history(client, dorm, archive["id"])["items"][0]["action"]


def test_foreign_organization_cannot_read_or_change_history(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session, email="first-history@example.com")
    dorm = create_dorm(client)
    archive = create_archive(client, dorm)
    client.post(f"/api/dormitories/{dorm}/residents")
    sign_in(client, db_session, email="second-history@example.com")
    today = datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat()
    response = client.get(
        f"/api/dormitories/{dorm}/tabs/{archive['id']}/history?from={today}&to={today}"
    )
    assert response.status_code == 404


def test_archive_template_keeps_type_but_uses_target_history(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    first = create_dorm(client)
    second = create_dorm(client, "Южное")
    original = create_archive(client, first)
    assert client.post(f"/api/dormitories/{first}/residents").status_code == 201
    copied = client.post(
        f"/api/dormitories/{second}/tabs", json={"name": "История", "source_tab_id": original["id"]}
    )
    assert copied.status_code == 201, copied.text
    assert copied.json()["kind"] == "archive"
    assert copied.json()["options"] == original["options"]
    assert history(client, second, copied.json()["id"])["items"] == []
    assert client.delete(f"/api/dormitories/{first}/tabs/{original['id']}").status_code == 204
    replacement = create_archive(client, first)
    assert len(history(client, first, replacement["id"])["items"]) == 1


def test_report_and_places_cells_have_row_hostel_metric_and_day_context(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dorm(client)
    archive = create_archive(client, dorm)
    row = client.post(f"/api/dormitories/{dorm}/report/rows", json={"name": "Контроль"}).json()
    for value in ("10", "12"):
        assert (
            client.put(
                f"/api/dormitories/{dorm}/report/rows/{row['id']}/cells/2026-11-02",
                json={"value": value},
            ).status_code
            == 204
        )
    from datetime import date

    hostel = Hostel(dormitory_id=dorm, name="Корпус №1", active_from_month=date(2026, 11, 1))
    db_session.add(hostel)
    db_session.commit()
    for value in (5, 8):
        response = client.put(
            f"/api/dormitories/{dorm}/hostels/{hostel.id}/cells/2026-11-02/paid_m",
            json={"value": value},
        )
        assert response.status_code == 204, response.text
    rows = history(client, dorm, archive["id"])["items"]
    assert len(rows) == 4
    assert any(
        "Общий отчёт → строка «Контроль» → 02.11.2026" in item["action"]
        and "«10» на «12»" in item["action"]
        for item in rows
    )
    assert any(
        "хостел «Корпус №1» → Оплачено мест — М → 02.11.2026" in item["action"]
        and "«5» на «8»" in item["action"]
        for item in rows
    )
