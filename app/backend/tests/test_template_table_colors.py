"""Цвета должны следовать за строками и столбцами при смене их ID."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import sign_in
from tests.test_dormitory_structure import create_selected, custom, table
from tests.test_reports import create_dormitory


def set_colors(client: TestClient, base: str, key: str, **colors: dict[str, str]) -> None:
    path = f"{base}/table-views/{key}"
    revision = client.get(path).json()["revision"]
    response = client.put(path, json={"revision": revision, "state": colors})
    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "source_kind", ["report_template", "selected_template", "sample", "structure"]
)
def test_report_and_source_table_keep_colors_with_new_ids(
    client: TestClient, db_session: Session, source_kind: str
) -> None:
    sign_in(client, db_session)
    source = create_dormitory(client)
    base = f"/api/dormitories/{source}"
    tab = custom(client, source, "Документы")
    key = tab["table_key"]
    column_id = table(client, source, tab)[0]["id"]
    person = client.post(f"{base}/tabs/{tab['id']}/rows").json()
    set_colors(
        client,
        base,
        key,
        row_colors={str(person["id"]): "rose"},
        column_colors={str(column_id): "mint"},
    )
    report_row = client.post(
        base + "/report/rows",
        json={
            "name": "Документы в работе",
            "link": {"table_key": key, "column_id": column_id, "operator": "not_empty"},
        },
    ).json()
    date_colors = {"name": "sage", "2026-10-01": "peach"}
    set_colors(
        client,
        base,
        "report",
        row_colors={str(report_row["id"]): "sky"},
        column_colors=date_colors,
    )
    payload: dict[str, Any] = {"name": "Копия", "client_name": "Клиент"}
    if source_kind in ("report_template", "selected_template"):
        saved = client.post(
            "/api/report-templates", json={"dormitory_id": source, "name": "Отчёт с цветом"}
        )
        assert saved.status_code == 201, saved.text
        payload["template_id"] = saved.json()["id"]
    if source_kind in ("selected_template", "sample"):
        payload["tabs"] = [
            {"source_id": f"standard:{source}:report"},
            {"source_id": f"custom:{tab['id']}"},
        ]
    if source_kind == "structure":
        saved = client.post(
            "/api/dormitory-templates", json={"dormitory_id": source, "name": "Структура с цветом"}
        )
        assert saved.status_code == 201, saved.text
        payload.update(
            structure_template_id=saved.json()["id"], structure_template_keys=["report", key]
        )
    if source_kind != "sample":
        # После сохранения цвета отчёта в образце уже могут поменяться.
        set_colors(client, base, "report", row_colors={str(report_row["id"]): "blue"})

    created = client.post("/api/dormitories", json=payload)
    assert created.status_code == 201, created.text
    target = f"/api/dormitories/{created.json()['id']}"
    report = client.get(target + "/report?from=2026-10-01&to=2026-10-01").json()
    copied_row = next(row for row in report["rows"] if row["name"] == report_row["name"])
    assert copied_row["id"] != report_row["id"]
    assert client.get(target + "/table-views/report").json()["state"] == {
        "rows": [],
        "columns": [],
        "row_colors": {str(copied_row["id"]): "sky"},
        "column_colors": date_colors,
    }
    copied_key = copied_row["link"]["table_key"]
    copied_column = copied_row["link"]["column_id"]
    assert copied_key != key and copied_column != column_id
    assert client.get(f"{target}/table-views/{copied_key}").json()["state"] == {
        "rows": [],
        "columns": [],
        "row_colors": {},
        "column_colors": {str(copied_column): "mint"},
    }
    assert client.get(f"{target}/tabs/{copied_key.removeprefix('custom_')}/rows").json() == []


def test_tab_template_keeps_colors_for_nested_tables(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}"
    parent = custom(client, dorm, "Документы")
    child = custom(client, dorm, "Паспорта", parent_id=parent["id"])
    for tab, color in ((parent, "mint"), (child, "peach")):
        column_id = table(client, dorm, tab)[0]["id"]
        set_colors(client, base, tab["table_key"], column_colors={str(column_id): color})

    result = client.post(base + "/tabs", json={"name": "Копия", "source_tab_id": parent["id"]})
    assert result.status_code == 201, result.text
    copied = result.json()
    copied_child = next(
        tab for tab in client.get(base + "/tabs").json() if tab["parent_id"] == copied["id"]
    )
    for tab, color in ((copied, "mint"), (copied_child, "peach")):
        key = tab["table_key"]
        column_id = client.get(f"{base}/tables/{key}/columns").json()[0]["id"]
        assert client.get(f"{base}/table-views/{key}").json()["state"]["column_colors"] == {
            str(column_id): color
        }


def test_standard_samples_keep_column_and_placement_colors(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    source = create_dormitory(client)
    base = f"/api/dormitories/{source}"
    original = client.get(base + "/tables/residents/columns").json()[0]
    set_colors(client, base, "residents", column_colors={str(original["id"]): "sand"})
    hostel = client.post(base + "/hostels", json={"name": "Корпус А", "month": "2026-10-01"})
    assert hostel.status_code == 201, hostel.text
    place_colors = {
        "row_colors": {"residents_m": "sage"},
        "column_colors": {"2026-10-01": "sky"},
    }
    set_colors(client, base, "places", **place_colors)

    created = create_selected(client, f"standard:{source}:residents", f"standard:{source}:places")
    assert created.status_code == 201, created.text
    target = f"/api/dormitories/{created.json()['id']}"
    copied = client.get(target + "/tables/residents/columns").json()[0]
    assert copied["id"] != original["id"]
    assert client.get(target + "/table-views/residents").json()["state"]["column_colors"] == {
        str(copied["id"]): "sand"
    }
    state = client.get(target + "/table-views/places").json()["state"]
    assert {key: state[key] for key in place_colors} == place_colors
