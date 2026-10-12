"""Удаление только пустых таблиц, скрытие без потери данных и блокировка записи."""

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTabEntry
from app.models.table_column import TableColumn
from tests.conftest import sign_in
from tests.test_custom_tabs import create_table, tab
from tests.test_reports import create_dormitory


def test_empty_tab_deletion_removes_whole_schema_and_checks_dormitory(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    first, second = create_dormitory(client), create_dormitory(client, "Другое")
    empty = tab(client, first)
    base = f"/api/dormitories/{first}/tabs/{empty['id']}"
    assert client.delete(f"/api/dormitories/{second}/tabs/{empty['id']}").status_code == 404
    assert (
        client.patch(
            f"/api/dormitories/{second}/tabs/{empty['id']}", json={"is_active": False}
        ).status_code
        == 404
    )
    assert client.delete(base).status_code == 204
    assert client.delete(base).status_code == 404
    item = tab(client, first)
    base, table_base = create_table(client, first, item)
    columns = client.get(table_base + "/columns").json()
    assert len(columns) == 6
    assert client.patch(base, json={"is_active": False}).status_code == 200
    assert client.delete(base).status_code == 204
    assert client.get(f"/api/dormitories/{first}/tabs").json() == []
    assert client.get(table_base + "/columns").status_code == 404
    assert not list(
        db_session.scalars(select(TableColumn).where(TableColumn.dormitory_id == first))
    )
    assert client.get("/api/custom-tab-templates").json() == []


def test_any_row_including_old_or_blank_prevents_deletion(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    item = tab(client, dorm)
    base, table_base = create_table(client, dorm, item)
    row = client.post(base + "/rows").json()
    # Even an empty row is a record and must be removed deliberately first.
    response = client.delete(base)
    assert response.status_code == 409 and "за всё время" in response.json()["detail"]
    record = db_session.get(CustomTabEntry, row["id"])
    assert record is not None
    record.created_at = datetime(2020, 1, 1, tzinfo=UTC)
    record.custom_values = {"999": "Значение удалённого столбца"}
    db_session.commit()
    metadata = client.get(f"/api/dormitories/{dorm}/tabs").json()[0]
    assert metadata["has_data"] and metadata["delete_block_reason"]
    assert client.delete(base).status_code == 409
    assert client.patch(base, json={"is_active": False}).status_code == 200
    assert client.delete(base).status_code == 409
    assert client.get(base + "/rows").json()[0]["custom_values"] == {
        "999": "Значение удалённого столбца"
    }
    assert client.get(table_base + "/columns").status_code == 200


def test_hidden_tab_blocks_every_table_mutation_but_can_be_read_and_restored(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    item = tab(client, dorm)
    base, table_base = create_table(client, dorm, item)
    columns = client.get(table_base + "/columns").json()
    name, archived = columns[:2]
    row = client.post(base + "/rows").json()
    cell = f"{table_base}/rows/{row['id']}/cells/{name['id']}"
    assert client.put(cell, json={"value": "Иванов"}).status_code == 200
    assert client.delete(f"{table_base}/columns/{archived['id']}").status_code == 204
    hidden = client.patch(base, json={"is_active": False})
    assert hidden.status_code == 200 and not hidden.json()["is_active"]
    for method, url, body in [
        ("POST", base + "/rows", None),
        ("DELETE", f"{base}/rows/{row['id']}", None),
        ("PUT", cell, {"value": "Другое"}),
        ("POST", table_base + "/columns", {"name": "Новое", "kind": "text"}),
        ("PATCH", f"{table_base}/columns/{name['id']}", {"name": "Другое", "kind": "text"}),
        ("DELETE", f"{table_base}/columns/{name['id']}", None),
        ("POST", f"{table_base}/columns/{archived['id']}/restore", None),
    ]:
        response = client.request(method, url, json=body)
        assert response.status_code == 409, (method, url, response.text)
        assert "скрыта" in response.json()["detail"]
    assert client.get(base + "/rows").json()[0]["custom_values"][str(name["id"])] == "Иванов"
    assert client.get(table_base + "/columns").status_code == 200
    assert client.patch(base, json={"is_active": True}).json()["is_active"]
    assert client.put(cell, json={"value": "Петров"}).status_code == 200
    assert client.post(base + "/rows").status_code == 201
    assert client.post(f"{table_base}/columns/{archived['id']}/restore").status_code == 200
    blank = tab(client, dorm, "Пустая")
    blank_base = f"/api/dormitories/{dorm}/tabs/{blank['id']}"
    assert client.patch(blank_base, json={"is_active": False}).status_code == 200
    assert (
        client.post(
            blank_base + "/table", json={"columns": [{"name": "Поле", "kind": "text"}]}
        ).status_code
        == 409
    )
    assert client.patch(blank_base, json={"is_active": True}).status_code == 200
    assert (
        client.post(
            blank_base + "/table", json={"columns": [{"name": "Поле", "kind": "text"}]}
        ).status_code
        == 201
    )


def test_hidden_sources_still_feed_report_and_templates_without_sharing_data(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    item = tab(client, dorm)
    base, table_base = create_table(client, dorm, item)
    columns = client.get(table_base + "/columns").json()
    name, event = columns[:2]
    row = client.post(base + "/rows").json()
    for column, value in [(name, "Иванов"), (event, "2026-10-08")]:
        assert (
            client.put(
                f"{table_base}/rows/{row['id']}/cells/{column['id']}", json={"value": value}
            ).status_code
            == 200
        )
    report_base = f"/api/dormitories/{dorm}/report"
    link = {
        "table_key": item["table_key"],
        "column_id": name["id"],
        "value": "Иванов",
        "date_column_id": event["id"],
    }
    linked = client.post(report_base + "/rows", json={"name": "Люди", "link": link})
    assert linked.status_code == 201
    assert client.patch(base, json={"is_active": False}).status_code == 200
    result = client.get(report_base + "?from=2026-10-08&to=2026-10-09").json()["rows"][-1]
    assert result["values"] == {"2026-10-08": "1", "2026-10-09": "0"} and not result["errors"]
    template = client.post(
        "/api/report-templates", json={"dormitory_id": dorm, "name": "Со скрытой вкладкой"}
    )
    assert template.status_code == 201
    copy = client.post(
        "/api/dormitories",
        json={"name": "Копия", "client_name": "Клиент", "template_id": template.json()["id"]},
    )
    assert copy.status_code == 201, copy.text
    copied = client.get(f"/api/dormitories/{copy.json()['id']}/tabs").json()[0]
    assert copied["is_active"] and not copied["has_data"]
    assert copied["table_key"] != item["table_key"]
    other = create_dormitory(client, "По шаблону вкладки")
    cloned = tab(client, other, source=item["id"])
    assert cloned["is_active"] and not cloned["has_data"]


def test_empty_linked_tab_cannot_be_deleted_until_report_link_is_removed(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    item = tab(client, dorm)
    base, table_base = create_table(client, dorm, item)
    name = client.get(table_base + "/columns").json()[0]
    report_base = f"/api/dormitories/{dorm}/report/rows"
    linked = client.post(
        report_base,
        json={
            "name": "Люди",
            "link": {"table_key": item["table_key"], "column_id": name["id"], "value": "Иванов"},
        },
    ).json()
    metadata = client.get(f"/api/dormitories/{dorm}/tabs").json()[0]
    assert not metadata["has_data"] and "Люди" in metadata["delete_block_reason"]
    assert client.delete(base).status_code == 409
    assert client.patch(base, json={"is_active": False}).status_code == 200
    assert client.delete(f"{report_base}/{linked['id']}").status_code == 204
    assert client.delete(base).status_code == 204


@pytest.mark.parametrize("active,expected", [(None, 401), (False, 403)])
def test_status_actions_require_active_session(
    client: TestClient, db_session: Session, active: bool | None, expected: int
) -> None:
    if active is not None:
        sign_in(client, db_session, is_active=active)
    base = "/api/dormitories/1/tabs/1"
    assert client.patch(base, json={"is_active": False}).status_code == expected
    assert client.delete(base).status_code == expected
