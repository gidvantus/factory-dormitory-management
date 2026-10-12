"""Атомарные изменения схемы и независимость сохранённых шаблонов."""

from copy import deepcopy

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import sign_in
from tests.test_dormitory_structure import custom, table
from tests.test_reports import create_dormitory


def input_columns(columns):
    return [
        {key: col[key] for key in ("id", "name", "kind", "options", "archived")} for col in columns
    ]


def test_batch_preserves_values_rejects_stale_revision_and_rolls_back(
    client: TestClient, db_session: Session
):
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}"
    row = client.post(base + "/residents").json()
    assert (
        client.patch(
            base + f"/residents/{row['id']}?month=2026-10-01", json={"full_name": "Иванов Иван"}
        ).status_code
        == 200
    )
    snapshot = client.get(base + "/settings").json()
    columns = input_columns(snapshot["tables"]["residents"])
    fullname = next(col for col in columns if col["name"] == "ФИО")
    fullname["name"] = "Сотрудник"
    columns.append({"name": "Договор", "kind": "text", "options": [], "archived": False})
    payload = {
        "revision": snapshot["revision"],
        "tables": [{"key": "residents", "columns": columns}],
    }
    response = client.put(base + "/settings", json=payload)
    assert response.status_code == 200, response.text
    assert (
        client.get(base + "/residents?month=2026-10-01").json()["residents"][0]["id"] == row["id"]
    )
    assert client.put(base + "/settings", json=payload).status_code == 409
    assert (
        client.get(base + "/residents?month=2026-10-01").json()["residents"][0]["full_name"]
        == "Иванов Иван"
    )
    current = response.json()
    payload["revision"] = current["revision"]
    payload["tables"][0]["columns"] = input_columns(current["tables"]["residents"])
    payload["tables"][0]["columns"][0]["name"] = "Не должно сохраниться"
    payload["deleted"] = ["residents"]
    assert client.put(base + "/settings", json=payload).status_code == 409
    assert client.get(base + "/settings").json()["revision"] == current["revision"]


def test_batch_creates_tree_and_tables_together_and_guards_links(
    client: TestClient, db_session: Session
):
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}"
    snapshot = client.get(base + "/settings").json()
    response = client.put(
        base + "/settings",
        json={
            "revision": snapshot["revision"],
            "tabs": [
                {"key": "new_child", "name": "Документы", "parent_key": "new_root"},
                {"key": "new_root", "name": "Проверки", "parent_key": "residents"},
            ],
            "tables": [{"key": "new_child", "columns": [{"name": "Дата", "kind": "date"}]}],
        },
    )
    assert response.status_code == 200, response.text
    snapshot = response.json()
    child = next(tab for tab in snapshot["tabs"] if tab["name"] == "Документы")
    col = snapshot["tables"][child["table_key"]][0]
    link = client.post(
        base + "/report/rows",
        json={
            "name": "Проверены",
            "link": {
                "table_key": child["table_key"],
                "column_id": col["id"],
                "operator": "not_empty",
                "value": None,
                "date_column_id": col["id"],
            },
        },
    )
    assert link.status_code == 201, link.text
    snapshot = client.get(base + "/settings").json()
    columns = input_columns(snapshot["tables"][child["table_key"]])
    columns[0]["archived"] = True
    response = client.put(
        base + "/settings",
        json={
            "revision": snapshot["revision"],
            "tables": [{"key": child["table_key"], "columns": columns}],
        },
    )
    assert response.status_code == 409 and "Проверены" in response.text


def test_structure_template_is_frozen_and_remaps_links_without_records(
    client: TestClient, db_session: Session
):
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}"
    tab = custom(client, dorm, "Документы", parent_section="residents")
    columns = table(client, dorm, tab)
    status = next(col for col in columns if col["name"] == "Статус")
    day = next(col for col in columns if col["name"] == "Дата")
    rule = {
        "table_key": tab["table_key"],
        "column_id": status["id"],
        "operator": "equals",
        "value": status["options"][0]["id"],
        "date_column_id": day["id"],
    }
    response = client.post(base + "/report/rows", json={"name": "Готовые", "link": rule})
    assert response.status_code == 201, response.text
    client.post(base + "/residents")
    client.post(base + f"/tabs/{tab['id']}/rows")
    saved = client.post(
        "/api/dormitory-templates", json={"dormitory_id": dorm, "name": "Структура"}
    )
    assert saved.status_code == 201, saved.text
    template_id = saved.json()["id"]
    snapshot = client.get(f"/api/dormitory-templates/{template_id}").json()
    original = deepcopy(snapshot)
    changed_source = client.patch(
        base + f"/tables/{tab['table_key']}/columns/{status['id']}",
        json={"name": "Изменён", "kind": "select", "options": status["options"]},
    )
    assert changed_source.status_code == 200, changed_source.text
    assert client.get(f"/api/dormitory-templates/{template_id}").json() == original
    created = client.post(
        "/api/dormitories",
        json={"name": "Копия", "client_name": "Клиент", "structure_template_id": template_id},
    )
    assert created.status_code == 201, created.text
    target_base = f"/api/dormitories/{created.json()['id']}"
    target = client.get(target_base + "/settings").json()
    copied = next(item for item in target["tabs"] if item["name"] == "Документы")
    copied_status = next(
        col for col in target["tables"][copied["table_key"]] if col["name"] == "Статус"
    )
    copied_rule = next(row["link"] for row in target["rules"] if row["name"] == "Готовые")
    assert copied_rule["table_key"] == copied["table_key"] != tab["table_key"]
    assert copied_rule["column_id"] == copied_status["id"] != status["id"]
    assert copied_rule["value"] == copied_status["options"][0]["id"] != rule["value"]
    assert client.get(target_base + "/residents?month=2026-10-01").json()["residents"] == []
    assert client.get(target_base + f"/tabs/{copied['id']}/rows").json() == []
    assert client.delete(f"/api/dormitory-templates/{template_id}").status_code == 204
    assert client.get(target_base + "/settings").status_code == 200


def test_partial_template_detaches_subtab_and_rejects_missing_link_source_atomically(
    client: TestClient, db_session: Session
):
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    tab = custom(client, dorm, "Документы", parent_section="residents")
    columns = table(client, dorm, tab)
    day = next(col for col in columns if col["name"] == "Дата")
    base = f"/api/dormitories/{dorm}"
    assert (
        client.post(
            base + "/report/rows",
            json={
                "name": "Документы оформлены",
                "link": {
                    "table_key": tab["table_key"],
                    "column_id": day["id"],
                    "operator": "not_empty",
                    "value": None,
                    "date_column_id": day["id"],
                },
            },
        ).status_code
        == 201
    )
    saved = client.post(
        "/api/dormitory-templates", json={"dormitory_id": dorm, "name": "Выбор"}
    ).json()
    payload = {
        "name": "Копия",
        "client_name": "Клиент",
        "structure_template_id": saved["id"],
        "structure_template_keys": [tab["table_key"]],
    }
    created = client.post("/api/dormitories", json=payload)
    assert created.status_code == 201, created.text
    target = created.json()
    assert target["section_states"]["residents"] == "deleted"
    copied = client.get(f"/api/dormitories/{target['id']}/tabs").json()[0]
    assert copied["parent_id"] is None and copied["parent_section"] is None
    before = client.get("/api/dormitories").json()
    payload["structure_template_keys"] = ["report"]
    response = client.post("/api/dormitories", json=payload)
    assert response.status_code == 422 and "Документы оформлены" in response.text
    assert client.get("/api/dormitories").json() == before
