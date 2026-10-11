"""Независимые подвкладки, стандартные разделы и запрет записи после скрытия."""

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTab
from app.models.inflow import PersonnelInflow
from app.models.table_column import TableColumn
from tests.conftest import sign_in
from tests.test_reports import create_dormitory


def setup_dorm(client: TestClient, db: Session) -> str:
    sign_in(client, db)
    return f"/api/dormitories/{create_dormitory(client)}"


@pytest.mark.parametrize(
    "key",
    [
        "report",
        "places",
        "residents",
        "movement",
        "payments",
        "archive",
        "inflow",
        "outflow",
        "advance",
        "settlement",
    ],
)
def test_standard_sections_delete_empty_and_readd_defaults(
    client: TestClient, db_session: Session, key: str
) -> None:
    base = setup_dorm(client, db_session)
    if key in ("residents", "inflow", "outflow", "advance", "settlement", "archive"):
        columns = client.get(f"{base}/tables/{key}/columns").json()
        assert columns
        assert (
            client.post(
                f"{base}/tables/{key}/columns", json={"name": "Временный", "kind": "text"}
            ).status_code
            == 201
        )
    result = client.delete(f"{base}/sections/{key}")
    assert result.status_code == 200, result.text
    assert next(item for item in result.json() if item["key"] == key)["status"] == "deleted"
    if key in ("residents", "inflow", "outflow", "advance", "settlement", "archive"):
        assert client.get(f"{base}/tables/{key}/columns").status_code == 409
    assert client.patch(f"{base}/sections/{key}", json={"status": "active"}).status_code == 200
    if key in ("residents", "inflow", "outflow", "advance", "settlement", "archive"):
        restored = client.get(f"{base}/tables/{key}/columns").json()
        assert len(restored) == len(columns)
        assert not any(item["name"] == "Временный" for item in restored)
    # A deleted empty report keeps zero dashboard metrics instead of breaking totals.
    assert client.get(f"{base}/report?from=2026-01-01&to=2026-01-02").status_code == 200


@pytest.mark.parametrize(
    ("key", "url", "body"),
    [
        ("residents", "/residents", None),
        ("inflow", "/inflow", None),
        ("outflow", "/outflow", None),
        ("advance", "/payments/advance", None),
        ("settlement", "/payments/settlement", None),
        ("archive", "/tables/archive/rows", None),
        ("places", "/hostels", {"name": "Хостел", "month": "2020-01-01"}),
        ("report", "/report/rows", {"name": "Показатель"}),
    ],
)
def test_standard_hidden_blocks_creation_and_all_time_records_prevent_deletion(
    client: TestClient, db_session: Session, key: str, url: str, body: dict[str, str] | None
) -> None:
    base = setup_dorm(client, db_session)
    assert client.patch(f"{base}/sections/{key}", json={"status": "hidden"}).status_code == 200
    assert client.post(base + url, json=body).status_code == 409
    assert client.patch(f"{base}/sections/{key}", json={"status": "active"}).status_code == 200
    result = client.post(base + url, json=body)
    assert result.status_code == 201, result.text
    assert client.delete(f"{base}/sections/{key}").status_code == 409
    parent = {
        "inflow": "movement",
        "outflow": "movement",
        "advance": "payments",
        "settlement": "payments",
    }.get(key)
    if parent:
        assert client.delete(f"{base}/sections/{parent}").status_code == 409
        assert (
            client.patch(f"{base}/sections/{parent}", json={"status": "hidden"}).status_code == 200
        )
        assert client.post(base + url, json=body).status_code == 409


def test_independent_standard_subtab_hidden_data_and_report_dependency(
    client: TestClient, db_session: Session
) -> None:
    base = setup_dorm(client, db_session)
    dorm = int(base.rsplit("/", 1)[-1])
    columns = client.get(base + "/tables/inflow/columns").json()
    name = next(col for col in columns if col["builtin_key"] == "full_name")
    link = {
        "name": "Приехали",
        "link": {
            "table_key": "inflow",
            "column_id": name["id"],
            "operator": "not_empty",
            "value": None,
        },
    }
    assert client.post(base + "/report/rows", json=link).status_code == 201
    assert client.delete(base + "/sections/inflow").status_code == 409
    row = client.post(base + "/inflow").json()
    assert (
        client.patch(
            f"{base}/inflow/{row['id']}",
            json={"full_name": "Иванов", "settlement_date": "2020-01-01"},
        ).status_code
        == 200
    )
    historical = db_session.get(PersonnelInflow, row["id"])
    assert historical is not None
    # Old rows must count even if absent from the current-month screen.
    assert client.delete(base + "/sections/movement").status_code == 409
    assert client.patch(base + "/sections/inflow", json={"status": "hidden"}).status_code == 200
    assert client.post(base + "/outflow").status_code == 201
    assert (
        client.patch(f"{base}/inflow/{row['id']}", json={"full_name": "Другой"}).status_code == 409
    )
    assert client.delete(f"{base}/inflow/{row['id']}").status_code == 409
    assert (
        client.post(
            base + "/tables/inflow/columns", json={"name": "Новое", "kind": "text"}
        ).status_code
        == 409
    )
    report = client.get(
        base + f"/report?from={historical.created_at.date()}&to={historical.created_at.date()}"
    ).json()
    assert (
        next(item for item in report["rows"] if item["name"] == "Приехали")["values"][
            historical.created_at.date().isoformat()
        ]
        == "1"
    )
    assert list(
        db_session.scalars(select(PersonnelInflow).where(PersonnelInflow.dormitory_id == dorm))
    )


def test_child_tables_template_copy_independence_hidden_parent_and_safe_deletion(
    client: TestClient, db_session: Session
) -> None:
    base = setup_dorm(client, db_session)
    group = client.post(
        base + "/tabs", json={"name": "Документы", "subtabs": ["Паспорта", "Допуски"]}
    ).json()
    assert group["is_group"] and not group["table_created"]
    children = [tab for tab in client.get(base + "/tabs").json() if tab["parent_id"] == group["id"]]
    assert [item["name"] for item in children] == ["Паспорта", "Допуски"]
    first = children[0]
    table = f"{base}/tabs/{first['id']}"
    schema = f"{base}/tables/{first['table_key']}"
    assert (
        client.post(
            f"{base}/tabs/{group['id']}/table",
            json={"columns": [{"name": "Статус", "kind": "text"}]},
        ).status_code
        == 201
    )
    assert (
        client.post(
            table + "/table",
            json={
                "columns": [{"name": "Статус", "kind": "select", "options": [{"label": "Готов"}]}]
            },
        ).status_code
        == 201
    )
    source_column = client.get(schema + "/columns").json()[0]
    other = create_dormitory(client, "Копия")
    copied = client.post(
        f"/api/dormitories/{other}/tabs",
        json={"name": "Копия документов", "source_tab_id": group["id"]},
    ).json()
    copied_children = [
        item
        for item in client.get(f"/api/dormitories/{other}/tabs").json()
        if item["parent_id"] == copied["id"]
    ]
    assert len(copied_children) == 2
    copied_column = client.get(
        f"/api/dormitories/{other}/tables/{copied_children[0]['table_key']}/columns"
    ).json()[0]
    assert copied_column["id"] != source_column["id"]
    assert copied_column["options"][0]["id"] != source_column["options"][0]["id"]
    assert client.get(f"/api/dormitories/{other}/tabs/{copied_children[0]['id']}/rows").json() == []
    # Delete an empty child independently; siblings and source schema remain intact.
    assert (
        client.delete(f"/api/dormitories/{other}/tabs/{copied_children[0]['id']}").status_code
        == 204
    )
    assert client.get(schema + "/columns").json()[0] == source_column
    assert client.patch(f"{base}/tabs/{group['id']}", json={"is_active": False}).status_code == 200
    assert client.post(table + "/rows").status_code == 409
    assert (
        client.post(base + "/tabs", json={"name": "Новая", "parent_id": group["id"]}).status_code
        == 409
    )
    assert client.get(schema + "/columns").status_code == 200
    assert client.patch(f"{base}/tabs/{group['id']}", json={"is_active": True}).status_code == 200
    row = client.post(table + "/rows").json()
    assert client.delete(f"{base}/tabs/{group['id']}").status_code == 409
    assert client.delete(f"{table}/rows/{row['id']}").status_code == 204
    assert client.delete(f"{base}/tabs/{group['id']}").status_code == 204
    assert db_session.get(CustomTab, first["id"]) is None
    assert not list(
        db_session.scalars(select(TableColumn).where(TableColumn.table_key == first["table_key"]))
    )


def test_subtab_names_no_cross_dorm_parent_or_nested_groups(
    client: TestClient, db_session: Session
) -> None:
    base = setup_dorm(client, db_session)
    assert (
        client.post(base + "/tabs", json={"name": "Группа", "subtabs": ["А", " а "]}).status_code
        == 422
    )


def test_report_template_restores_subtab_parent_and_links_without_rows(
    client: TestClient, db_session: Session
) -> None:
    base = setup_dorm(client, db_session)
    group = client.post(base + "/tabs", json={"name": "Проверки", "subtabs": ["Документы"]}).json()
    child = next(
        item for item in client.get(base + "/tabs").json() if item["parent_id"] == group["id"]
    )
    assert (
        client.post(
            f"{base}/tabs/{child['id']}/table", json={"columns": [{"name": "ФИО", "kind": "text"}]}
        ).status_code
        == 201
    )
    column = client.get(f"{base}/tables/{child['table_key']}/columns").json()[0]
    assert (
        client.post(
            base + "/report/rows",
            json={
                "name": "Проверены",
                "link": {
                    "table_key": child["table_key"],
                    "column_id": column["id"],
                    "operator": "not_empty",
                },
            },
        ).status_code
        == 201
    )
    template = client.post(
        "/api/report-templates",
        json={"name": "Шаблон с подвкладкой", "dormitory_id": int(base.rsplit("/", 1)[-1])},
    ).json()
    new_dorm = client.post(
        "/api/dormitories",
        json={"name": "Новое", "client_name": "Клиент", "template_id": template["id"]},
    ).json()
    target = f"/api/dormitories/{new_dorm['id']}"
    tabs = client.get(target + "/tabs").json()
    assert len(tabs) == 2
    parent = next(item for item in tabs if item["is_group"])
    restored = next(item for item in tabs if item["parent_id"] == parent["id"])
    assert parent["name"] == "Проверки" and restored["name"] == "Документы"
    assert client.get(f"{target}/tabs/{restored['id']}/rows").json() == []
    report = client.get(target + "/report?from=2026-10-01&to=2026-10-01").json()
    assert (
        next(row for row in report["rows"] if row["name"] == "Проверены")["link"]["table_key"]
        == restored["table_key"]
    )
    group = client.post(base + "/tabs", json={"name": "Группа", "subtabs": ["А"]}).json()
    other = create_dormitory(client, "Другое")
    assert (
        client.post(
            f"/api/dormitories/{other}/tabs", json={"name": "Чужая", "parent_id": group["id"]}
        ).status_code
        == 404
    )
    assert (
        client.post(base + "/tabs", json={"name": "А", "parent_id": group["id"]}).status_code == 409
    )
    assert (
        client.post(
            base + "/tabs",
            json={"name": "Вложенная", "parent_id": group["id"], "subtabs": ["Дополнительная"]},
        ).status_code
        == 201
    )


def test_resident_actions_cannot_mutate_hidden_target_tables(
    client: TestClient, db_session: Session
) -> None:
    base = setup_dorm(client, db_session)
    row = client.post(base + "/residents").json()
    assert (
        client.patch(
            f"{base}/residents/{row['id']}?month=2026-10-01", json={"full_name": "Иванов"}
        ).status_code
        == 200
    )
    assert client.patch(base + "/sections/advance", json={"status": "hidden"}).status_code == 200
    assert client.post(f"{base}/residents/{row['id']}/payments/advance").status_code == 409
    assert client.patch(base + "/sections/outflow", json={"status": "hidden"}).status_code == 200
    assert client.post(f"{base}/residents/{row['id']}/outflow/preview").status_code == 409
    target = create_dormitory(client, "Получатель")
    assert (
        client.patch(
            f"/api/dormitories/{target}/sections/residents", json={"status": "hidden"}
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"{base}/residents/{row['id']}/transfer/preview",
            json={"target_dormitory_id": target, "month": date(2026, 10, 1).isoformat()},
        ).status_code
        == 409
    )
