"""Актуальные столбцы для фильтрации людей и сохранение условий списка."""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import sign_in
from tests.test_personnel import API, create, workspace
from tests.test_reports import create_dormitory
from tests.test_table_columns import add_column


def test_workspace_exposes_active_source_columns_without_changing_rows(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    record = create(client, dorm)
    base = f"/api/dormitories/{dorm}/tables/residents"
    column = add_column(client, base, "Статус допуска")
    option = column["options"][0]["id"]
    assert (
        client.put(
            f"{base}/rows/{record['row_id']}/cells/{column['id']}", json={"value": option}
        ).status_code
        == 200
    )
    payment_column = add_column(
        client, f"/api/dormitories/{dorm}/tables/advance", "Служебная выплата", "text"
    )
    data = workspace(client)
    metadata = next(item for item in data["source_columns"] if item["id"] == column["id"])
    assert metadata == {
        "id": column["id"],
        "dormitory_id": dorm,
        "table_key": "residents",
        "source_name": "Проживающие",
        "name": "Статус допуска",
        "kind": "select",
        "builtin_key": None,
        "options": column["options"],
    }
    assert all(item["kind"] != "action" for item in data["source_columns"])
    assert not any(item["id"] == payment_column["id"] for item in data["source_columns"])
    before = data["employees"][0]["sources"][0]["values"]["custom_values"]
    options = [
        {**item, "label": "Допущен"} if index == 0 else item
        for index, item in enumerate(column["options"])
    ]
    assert (
        client.patch(
            f"{base}/columns/{column['id']}",
            json={"name": "Допуск", "kind": "select", "options": options},
        ).status_code
        == 200
    )
    updated = workspace(client)
    renamed = next(item for item in updated["source_columns"] if item["id"] == column["id"])
    assert renamed["name"] == "Допуск"
    assert renamed["options"][0]["label"] == "Допущен"
    assert updated["employees"][0]["sources"][0]["values"]["custom_values"] == before
    assert client.delete(f"{base}/columns/{column['id']}").status_code == 204
    assert not any(item["id"] == column["id"] for item in workspace(client)["source_columns"])


def test_saved_list_keeps_column_conditions_and_validates_them(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    rules = [
        {"field": "residence_status", "operator": "equals", "value": "Проживает"},
        {"field": "source:residents:статус:select", "operator": "equals", "value": "Допущен"},
    ]
    payload: dict[str, Any] = {
        "revision": 0,
        "blocks": [],
        "lists": [{"id": "allowed", "name": "Допущенные сотрудники", "column_filters": rules}],
    }
    response = client.put(API + "/preferences", json=payload)
    assert response.status_code == 200, response.text
    assert workspace(client)["preferences"]["lists"][0]["column_filters"] == rules
    payload["revision"] = 1
    payload["lists"][0]["column_filters"] = [{**rules[0], "operator": "unsupported"}]
    assert client.put(API + "/preferences", json=payload).status_code == 422
    payload["lists"][0]["column_filters"] = rules * 6
    assert client.put(API + "/preferences", json=payload).status_code == 422
    assert workspace(client)["preferences"]["lists"][0]["column_filters"] == rules
