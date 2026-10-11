"""Выбор структуры без записей и подвкладки под любым разделом."""

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.hostel import HostelCell
from tests.conftest import sign_in
from tests.test_reports import create_dormitory


def create_selected(client: TestClient, *sources: str):
    return client.post(
        "/api/dormitories",
        json={
            "name": "Независимая копия",
            "client_name": "Клиент",
            "tabs": [{"source_id": source} for source in sources],
        },
    )


def custom(client: TestClient, dorm: int, name: str, **parents):
    response = client.post(f"/api/dormitories/{dorm}/tabs", json={"name": name, **parents})
    assert response.status_code == 201, response.text
    return response.json()


def table(client: TestClient, dorm: int, tab: dict):
    base = f"/api/dormitories/{dorm}"
    response = client.post(
        f"{base}/tabs/{tab['id']}/table",
        json={
            "columns": [
                {"name": "Статус", "kind": "select", "options": [{"label": "Готов"}]},
                {"name": "Дата", "kind": "date"},
            ]
        },
    )
    assert response.status_code == 201, response.text
    return client.get(f"{base}/tables/{tab['table_key']}/columns").json()


def test_catalog_deduplicates_names_but_keeps_dormitory_samples_and_hidden_children(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    first, second = create_dormitory(client, "Первое"), create_dormitory(client, "Второе")
    child = custom(client, first, "Документы", parent_section="residents")
    sibling = custom(client, second, "документы")
    assert (
        client.patch(
            f"/api/dormitories/{first}/tabs/{child['id']}", json={"is_active": False}
        ).status_code
        == 200
    )
    result = client.get("/api/dormitory-tab-catalog").json()
    names = [item["id"] for item in result]
    assert len(names) == len(set(names)) == 11
    variants = next(item["variants"] for item in result if item["id"] == "документы")
    assert {item["id"] for item in variants} == {f"custom:{child['id']}", f"custom:{sibling['id']}"}
    assert next(item for item in variants if item["tab_id"] == child["id"])["path"] == [
        "Проживающие",
        "Документы",
    ]


def test_selected_standard_subtab_is_standalone_and_unselected_sections_are_absent(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    response = create_selected(client, "standard:0:inflow")
    assert response.status_code == 201, response.text
    dorm = response.json()
    assert dorm["section_parents"]["inflow"] is None
    assert dorm["section_states"]["movement"] == "deleted"
    base = f"/api/dormitories/{dorm['id']}"
    assert client.post(base + "/inflow").status_code == 201
    assert client.post(base + "/outflow").status_code == 409
    assert client.get(base + "/report?from=2026-10-01&to=2026-10-01").status_code == 200
    empty = create_selected(client).json()
    assert set(empty["section_states"].values()) == {"deleted"}
    assert (
        client.patch(
            f"/api/dormitories/{empty['id']}/sections/residents", json={"status": "active"}
        ).status_code
        == 200
    )


def test_custom_subtab_copy_is_independent_and_copies_no_rows_or_unselected_children(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    source = create_dormitory(client)
    root = custom(client, source, "Документы", parent_section="residents")
    columns = table(client, source, root)
    child = custom(client, source, "Паспорта", parent_id=root["id"])
    table(client, source, child)
    client.post(f"/api/dormitories/{source}/tabs/{child['id']}/rows")
    response = create_selected(client, f"custom:{child['id']}")
    assert response.status_code == 201, response.text
    target = response.json()["id"]
    tabs = client.get(f"/api/dormitories/{target}/tabs").json()
    assert len(tabs) == 1 and tabs[0]["parent_id"] is None and tabs[0]["parent_section"] is None
    assert client.get(f"/api/dormitories/{target}/tabs/{tabs[0]['id']}/rows").json() == []
    copied = client.get(f"/api/dormitories/{target}/tables/{tabs[0]['table_key']}/columns").json()
    assert copied[0]["options"][0]["label"] == "Готов"
    assert copied[0]["options"][0]["id"] != columns[0]["options"][0]["id"]
    assert (
        client.post(
            f"/api/dormitories/{source}/tables/{child['table_key']}/columns",
            json={"name": "Новый", "kind": "text"},
        ).status_code
        == 201
    )
    assert (
        client.get(f"/api/dormitories/{target}/tables/{tabs[0]['table_key']}/columns").json()
        == copied
    )
    nested = create_selected(
        client, "standard:0:residents", f"custom:{root['id']}", f"custom:{child['id']}"
    )
    assert nested.status_code == 201, nested.text
    tree = client.get(f"/api/dormitories/{nested.json()['id']}/tabs").json()
    new_root = next(item for item in tree if item["name"] == "Документы")
    assert new_root["parent_section"] == "residents" and new_root["table_created"]
    assert next(item for item in tree if item["name"] == "Паспорта")["parent_id"] == new_root["id"]


def test_deep_subtabs_in_standard_section_keep_main_table_and_prevent_unsafe_deletion(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}"
    resident = client.post(base + "/residents").json()
    root = custom(client, dorm, "Документы", parent_section="residents")
    columns = table(client, dorm, root)
    middle = custom(client, dorm, "Паспорта", parent_id=root["id"])
    leaf = custom(client, dorm, "Проверки", parent_id=middle["id"])
    table(client, dorm, leaf)
    assert (
        client.get(base + "/residents?month=2026-10-01").json()["residents"][0]["id"]
        == resident["id"]
    )
    assert client.post(f"{base}/tabs/{leaf['id']}/rows").status_code == 201
    assert client.delete(f"{base}/tabs/{root['id']}").status_code == 409
    assert client.delete(base + "/sections/residents").status_code == 409
    assert client.patch(base + "/sections/residents", json={"status": "hidden"}).status_code == 200
    assert client.post(f"{base}/tabs/{leaf['id']}/rows").status_code == 409
    assert client.post(f"{base}/tabs/{root['id']}/rows").status_code == 409
    assert client.get(f"{base}/tables/{root['table_key']}/columns").json() == columns
    assert (
        client.post(
            base + "/tabs", json={"name": "Приток", "parent_section": "movement"}
        ).status_code
        == 409
    )


def test_report_structure_remaps_custom_links_and_rolls_back_missing_dependency(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    source = create_dormitory(client)
    tab = custom(client, source, "Проверки", parent_section="residents")
    columns = table(client, source, tab)
    rule = {
        "table_key": tab["table_key"],
        "column_id": columns[0]["id"],
        "value": columns[0]["options"][0]["id"],
        "date_column_id": columns[1]["id"],
    }
    response = client.post(
        f"/api/dormitories/{source}/report/rows", json={"name": "Готовы", "link": rule}
    )
    assert response.status_code == 201, response.text
    before = len(client.get("/api/dormitories").json())
    missing = create_selected(client, f"standard:{source}:report")
    assert missing.status_code == 422 and "Проверки" in missing.text
    assert len(client.get("/api/dormitories").json()) == before
    response = create_selected(client, f"standard:{source}:report", f"custom:{tab['id']}")
    assert response.status_code == 201, response.text
    target = response.json()["id"]
    copied_tab = client.get(f"/api/dormitories/{target}/tabs").json()[0]
    copied_columns = client.get(
        f"/api/dormitories/{target}/tables/{copied_tab['table_key']}/columns"
    ).json()
    report = client.get(f"/api/dormitories/{target}/report?from=2026-10-01&to=2026-10-01").json()
    row = next(row for row in report["rows"] if row["name"] == "Готовы")
    assert row["link"]["table_key"] == copied_tab["table_key"]
    assert row["link"]["column_id"] == copied_columns[0]["id"]
    assert row["link"]["date_column_id"] == copied_columns[1]["id"]
    assert row["link"]["value"] == copied_columns[0]["options"][0]["id"]
    assert row["values"]["2026-10-01"] == "0"
    assert create_selected(client, "custom:999999").status_code == 409
    assert (
        create_selected(client, f"standard:{source}:report", "standard:0:report").status_code == 422
    )


def test_empty_standard_section_deletes_all_descendant_schemas(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    root = custom(client, dorm, "Документы", parent_section="inflow")
    leaf = custom(client, dorm, "Проверки", parent_id=root["id"])
    table(client, dorm, leaf)
    assert client.delete(f"/api/dormitories/{dorm}/sections/movement").status_code == 200
    assert client.get(f"/api/dormitories/{dorm}/tabs").json() == []


def test_builtin_schema_sample_and_places_definitions_copy_without_people_or_daily_values(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    source = create_dormitory(client)
    base = f"/api/dormitories/{source}"
    original = client.get(base + "/tables/residents/columns").json()
    assert (
        client.post(
            base + "/tables/residents/columns", json={"name": "Пропуск", "kind": "checkbox"}
        ).status_code
        == 201
    )
    assert client.delete(f"{base}/tables/residents/columns/{original[1]['id']}").status_code == 204
    client.post(base + "/residents")
    hostel = client.post(base + "/hostels", json={"name": "Корпус А", "month": "2026-10-01"}).json()
    assert hostel["id"]
    response = create_selected(client, f"standard:{source}:residents", f"standard:{source}:places")
    assert response.status_code == 201, response.text
    target = f"/api/dormitories/{response.json()['id']}"
    columns = client.get(target + "/tables/residents/columns").json()
    assert any(col["name"] == "Пропуск" and col["kind"] == "checkbox" for col in columns)
    assert next(col for col in columns if col["builtin_key"] == original[1]["builtin_key"])[
        "archived"
    ]
    people = client.get(target + "/residents?month=2026-10-01").json()
    assert people["residents"] == []
    assert [item["name"] for item in people["hostels"]] == ["Корпус А"]
    assert not list(
        db_session.scalars(
            select(HostelCell).where(HostelCell.hostel_id == people["hostels"][0]["id"])
        )
    )


def test_report_sample_rejects_incompatible_same_named_tab_and_restores_deep_template_parent(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    first, second = create_dormitory(client), create_dormitory(client, "Другое")
    root = custom(client, first, "Документы", parent_section="residents")
    middle = custom(client, first, "Проверки", parent_id=root["id"])
    leaf = custom(client, first, "Допуски", parent_id=middle["id"])
    columns = table(client, first, leaf)
    other = custom(client, second, "Допуски")
    assert (
        client.post(
            f"/api/dormitories/{second}/tabs/{other['id']}/table",
            json={"columns": [{"name": "Другое поле", "kind": "text"}]},
        ).status_code
        == 201
    )
    response = client.post(
        f"/api/dormitories/{first}/report/rows",
        json={
            "name": "Прошли",
            "link": {
                "table_key": leaf["table_key"],
                "column_id": columns[0]["id"],
                "operator": "not_empty",
            },
        },
    )
    assert response.status_code == 201, response.text
    incompatible = create_selected(client, f"standard:{first}:report", f"custom:{other['id']}")
    assert incompatible.status_code == 422 and "Статус" in incompatible.text
    template = client.post(
        "/api/report-templates", json={"name": "Вложенный", "dormitory_id": first}
    ).json()
    copied = client.post(
        "/api/dormitories",
        json={"name": "Старый формат", "client_name": "Клиент", "template_id": template["id"]},
    )
    assert copied.status_code == 201, copied.text
    tree = client.get(f"/api/dormitories/{copied.json()['id']}/tabs").json()
    assert len(tree) == 3
    new_root = next(item for item in tree if item["name"] == "Документы")
    new_middle = next(item for item in tree if item["name"] == "Проверки")
    new_leaf = next(item for item in tree if item["name"] == "Допуски")
    assert new_root["parent_section"] == "residents"
    assert new_middle["parent_id"] == new_root["id"]
    assert new_leaf["parent_id"] == new_middle["id"]
