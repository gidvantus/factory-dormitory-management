"""Изоляция вкладок, типизированные значения и независимые копии структуры."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import sign_in
from tests.test_reports import create_dormitory


def tab(
    client: TestClient, dorm: int, name: str = "Документы", source: int | None = None
) -> dict[str, Any]:
    response = client.post(
        f"/api/dormitories/{dorm}/tabs", json={"name": name, "source_tab_id": source}
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_table(client: TestClient, dorm: int, item: dict[str, Any]) -> tuple[str, str]:
    base = f"/api/dormitories/{dorm}/tabs/{item['id']}"
    response = client.post(
        base + "/table",
        json={
            "columns": [
                {"name": "ФИО", "kind": "text"},
                {"name": "Дата", "kind": "date"},
                {"name": "Количество", "kind": "number"},
                {"name": "Отметка", "kind": "checkbox"},
                {
                    "name": "Статус",
                    "kind": "select",
                    "options": [{"label": "Готов"}, {"label": "Ожидает"}],
                },
            ]
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["table_created"] is True
    return base, f"/api/dormitories/{dorm}/tables/{item['table_key']}"


def test_empty_tab_is_local_and_cannot_accept_rows_before_table(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    first, second = create_dormitory(client), create_dormitory(client, "Южное")
    item = tab(client, first)
    assert not item["table_created"]
    assert client.get(f"/api/dormitories/{first}/tabs").json() == [item]
    assert client.get(f"/api/dormitories/{second}/tabs").json() == []
    base = f"/api/dormitories/{first}/tabs/{item['id']}"
    assert client.post(base + "/rows").status_code == 409
    assert client.get(base + "/rows").status_code == 409
    assert (
        client.get(f"/api/dormitories/{first}/tables/{item['table_key']}/columns").status_code
        == 409
    )
    assert (
        client.post(
            f"/api/dormitories/{second}/tabs/{item['id']}/table",
            json={"columns": [{"name": "Имя", "kind": "text"}]},
        ).status_code
        == 404
    )
    templates = client.get("/api/custom-tab-templates").json()
    assert templates == [{**item, "dormitory_name": "Северное", "client_name": "Стройкомплект"}]


def test_typed_cells_archiving_and_row_isolation(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    first, second = tab(client, dorm), tab(client, dorm, "Проверки")
    base, table = create_table(client, dorm, first)
    other_base, other_table = create_table(client, dorm, second)
    columns = client.get(table + "/columns").json()
    by_name = {column["name"]: column for column in columns}
    row = client.post(base + "/rows").json()
    values = {
        "ФИО": "Иванов Иван",
        "Дата": "2026-10-09",
        "Количество": "12,5",
        "Отметка": True,
        "Статус": by_name["Статус"]["options"][0]["id"],
    }
    for name, value in values.items():
        response = client.put(
            f"{table}/rows/{row['id']}/cells/{by_name[name]['id']}", json={"value": value}
        )
        assert response.status_code == 200, response.text
    stored = client.get(base + "/rows").json()[0]["custom_values"]
    assert stored[str(by_name["Количество"]["id"])] == "12.5"
    assert stored[str(by_name["Отметка"]["id"])] is True
    assert (
        client.put(
            f"{table}/rows/{row['id']}/cells/{by_name['Дата']['id']}", json={"value": "вчера"}
        ).status_code
        == 422
    )
    assert (
        client.put(
            f"{table}/rows/{row['id']}/cells/{by_name['Отметка']['id']}", json={"value": "да"}
        ).status_code
        == 422
    )
    assert client.get(other_base + "/rows").json() == []
    assert client.delete(f"{other_base}/rows/{row['id']}").status_code == 404
    other_column = client.get(other_table + "/columns").json()[0]
    assert (
        client.put(
            f"{other_table}/rows/{row['id']}/cells/{other_column['id']}", json={"value": "Подмена"}
        ).status_code
        == 404
    )
    column = by_name["ФИО"]
    assert client.delete(f"{table}/columns/{column['id']}").status_code == 204
    assert client.post(f"{table}/columns/{column['id']}/restore").status_code == 200
    assert client.get(base + "/rows").json()[0]["custom_values"] == stored
    assert client.delete(f"{base}/rows/{row['id']}").status_code == 204
    assert client.get(base + "/rows").json() == []


def test_template_copies_schema_without_rows_and_never_tracks_source_changes(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    first, second = create_dormitory(client), create_dormitory(client, "Южное")
    source = tab(client, first)
    source_base, source_table = create_table(client, first, source)
    source_columns = client.get(source_table + "/columns").json()
    source_select = next(col for col in source_columns if col["kind"] == "select")
    source_row = client.post(source_base + "/rows").json()
    assert (
        client.put(
            f"{source_table}/rows/{source_row['id']}/cells/{source_select['id']}",
            json={"value": source_select["options"][0]["id"]},
        ).status_code
        == 200
    )
    copy = tab(client, second, source=source["id"])
    copy_base = f"/api/dormitories/{second}/tabs/{copy['id']}"
    copy_table = f"/api/dormitories/{second}/tables/{copy['table_key']}"
    copied_columns = client.get(copy_table + "/columns").json()
    assert copy["table_created"] is True
    assert [col["name"] for col in copied_columns] == [col["name"] for col in source_columns]
    assert [col["kind"] for col in copied_columns] == [col["kind"] for col in source_columns]
    assert {col["id"] for col in copied_columns}.isdisjoint({col["id"] for col in source_columns})
    copied_select = next(col for col in copied_columns if col["kind"] == "select")
    assert [option["label"] for option in copied_select["options"]] == ["Готов", "Ожидает"]
    assert copied_select["options"][0]["id"] != source_select["options"][0]["id"]
    assert client.get(copy_base + "/rows").json() == []
    source_select["options"][0]["label"] = "Совсем другое значение"
    assert (
        client.patch(
            f"{source_table}/columns/{source_select['id']}",
            json={"name": "Новый статус", "kind": "select", "options": source_select["options"]},
        ).status_code
        == 200
    )
    assert client.delete(f"{source_table}/columns/{source_columns[0]['id']}").status_code == 204
    assert (
        client.post(
            source_table + "/columns", json={"name": "Новое поле", "kind": "text"}
        ).status_code
        == 201
    )
    assert client.get(copy_table + "/columns").json() == copied_columns
    assert client.get(copy_base + "/rows").json() == []
    # Editing the copy likewise leaves both source structure and source values intact.
    assert client.delete(f"{copy_table}/columns/{copied_select['id']}").status_code == 204
    assert not next(
        col
        for col in client.get(source_table + "/columns").json()
        if col["id"] == source_select["id"]
    )["archived"]
    assert len(client.get(source_base + "/rows").json()) == 1


@pytest.mark.parametrize(
    "columns",
    [
        [],
        [{"name": "Поле", "kind": "action"}],
        [{"name": "Поле", "kind": "select", "options": []}],
        [{"name": "Поле", "kind": "text"}, {"name": "поле", "kind": "number"}],
        [{"name": "Удалить", "kind": "text"}],
    ],
)
def test_failed_table_setup_does_not_leave_partial_schema(
    client: TestClient, db_session: Session, columns: list[dict[str, Any]]
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    item = tab(client, dorm)
    base = f"/api/dormitories/{dorm}/tabs/{item['id']}"
    assert client.post(base + "/table", json={"columns": columns}).status_code in (409, 422)
    assert not client.get(f"/api/dormitories/{dorm}/tabs").json()[0]["table_created"]
    create_table(client, dorm, item)
    assert (
        client.post(
            base + "/table", json={"columns": [{"name": "Поле", "kind": "text"}]}
        ).status_code
        == 409
    )


def test_table_creation_accepts_more_than_one_hundred_columns(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    item = tab(client, dorm)
    columns = [{"name": f"Поле {index}", "kind": "text"} for index in range(101)]
    response = client.post(
        f"/api/dormitories/{dorm}/tabs/{item['id']}/table", json={"columns": columns}
    )
    assert response.status_code == 201, response.text
    stored = client.get(f"/api/dormitories/{dorm}/tables/{item['table_key']}/columns").json()
    assert [column["name"] for column in stored] == [column["name"] for column in columns] + [
        "Удалить"
    ]


def test_duplicate_names_and_missing_template_are_rejected(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    tab(client, dorm, "  Мои   документы  ")
    base = f"/api/dormitories/{dorm}/tabs"
    for name in ("мои документы", "Архив", "Общий отчет", "общий отчёт", "Размещение персонала"):
        assert client.post(base, json={"name": name}).status_code == 409
    for name in ("   ", "\x00", "x" * 121):
        assert client.post(base, json={"name": name}).status_code == 422
    assert client.post(base, json={"name": "Другое", "source_tab_id": 999999}).status_code == 404
    assert len(client.get(base).json()) == 1


@pytest.mark.parametrize("active,expected", [(None, 401), (False, 403)])
def test_custom_routes_require_active_session(
    client: TestClient, db_session: Session, active: bool | None, expected: int
) -> None:
    if active is not None:
        sign_in(client, db_session, is_active=active)
    for method, url, body in [
        ("GET", "/api/custom-tab-templates", None),
        ("GET", "/api/dormitories/1/tabs", None),
        ("POST", "/api/dormitories/1/tabs", {"name": "Документы"}),
        ("POST", "/api/dormitories/1/tabs/1/table", {"columns": [{"name": "Имя", "kind": "text"}]}),
        ("POST", "/api/dormitories/1/tabs/1/rows", None),
        ("GET", "/api/dormitories/1/tabs/1/rows", None),
        ("DELETE", "/api/dormitories/1/tabs/1/rows/1", None),
    ]:
        assert client.request(method, url, json=body).status_code == expected
