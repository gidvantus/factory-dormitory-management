"""Периоды, возможности и смена формата без потери данных."""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import sign_in
from tests.test_reports import create_dormitory


def create(client: TestClient, dorm: int, **options: Any) -> dict[str, Any]:
    response = client.post(
        f"/api/dormitories/{dorm}/tabs",
        json={
            "name": "Своя таблица",
            "options": options,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def configure(client: TestClient, dorm: int, tab: dict[str, Any], **patch: Any) -> dict[str, Any]:
    base = f"/api/dormitories/{dorm}"
    snapshot = client.get(base + "/settings").json()
    current = next(item for item in snapshot["tabs"] if item["id"] == tab["id"])
    response = client.put(
        base + "/settings",
        json={
            "revision": snapshot["revision"],
            "tabs": [
                {
                    "key": current["table_key"],
                    "name": current["name"],
                    "parent_key": None,
                    "options": {**current["options"], **patch},
                }
            ],
        },
    )
    assert response.status_code == 200, response.text
    return next(item for item in response.json()["tabs"] if item["id"] == tab["id"])


def test_filter_by_chosen_date_inclusive_and_missing_dates(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    tab = create(client, dorm, period_mode="range")
    base = f"/api/dormitories/{dorm}/tabs/{tab['id']}"
    table = f"/api/dormitories/{dorm}/tables/{tab['table_key']}"
    key = tab["options"]["date_column_id"]
    assert key and tab["table_created"]
    ids = []
    for date in ["2026-09-30", "2026-10-01", "2026-10-31", "2026-11-01", None]:
        row = client.post(base + "/rows").json()
        ids.append(row["id"])
        if date:
            assert (
                client.put(
                    f"{table}/rows/{row['id']}/cells/{key}", json={"value": date}
                ).status_code
                == 200
            )
    assert [
        row["id"] for row in client.get(base + "/rows?from=2026-10-01&to=2026-10-31").json()
    ] == ids[1:3]
    assert len(client.get(base + "/rows").json()) == 5
    for query in [
        "?from=2026-10-01",
        "?from=2026-10-31&to=2026-10-01",
        "?from=2025-01-01&to=2026-12-31",
    ]:
        assert client.get(base + "/rows" + query).status_code == 422
    assert client.delete(f"{table}/columns/{key}").status_code == 409
    row = client.post(base + "/rows?entry_date=2026-10-12").json()
    assert row["custom_values"][str(key)] == "2026-10-12"
    configure(client, dorm, tab, period_mode="none", date_column_id=None)
    assert len(client.get(base + "/rows?from=2026-10-01&to=2026-10-31").json()) == 6


def test_disabled_operations_clear_is_local_and_hidden_is_readonly(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    first, second = create_dormitory(client), create_dormitory(client, "Южное")
    tab = create(client, first, table_format="calendar", period_mode="month", clear_list=True)
    other = create(client, second, table_format="calendar", period_mode="month", clear_list=True)
    base = f"/api/dormitories/{first}/tabs/{tab['id']}"
    other_base = f"/api/dormitories/{second}/tabs/{other['id']}"
    row = client.post(base + "/rows").json()
    client.post(other_base + "/rows")
    configure(client, first, tab, add_row=False, row_actions=False, clear_list=False)
    assert client.post(base + "/rows").status_code == 409
    assert client.delete(base + f"/rows/{row['id']}").status_code == 409
    assert client.post(base + "/clear").status_code == 409
    configure(client, first, tab, clear_list=True)
    assert client.post(f"/api/dormitories/{second}/tabs/{tab['id']}/clear").status_code == 404
    client.patch(base, json={"is_active": False})
    assert client.post(base + "/clear").status_code == 409
    assert (
        client.put(base + f"/rows/{row['id']}/days/2026-10-12", json={"value": "2"}).status_code
        == 409
    )
    client.patch(base, json={"is_active": True})
    assert client.post(base + "/clear").json() == {"deleted": 1}
    assert client.get(base + "/rows").json() == []
    assert len(client.get(other_base + "/rows").json()) == 1


def test_calendar_survives_format_switch_and_templates_copy_only_structure(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    first, second = create_dormitory(client), create_dormitory(client, "Южное")
    tab = create(client, first, table_format="calendar", period_mode="month")
    base = f"/api/dormitories/{first}/tabs/{tab['id']}"
    row = client.post(base + "/rows").json()
    cell = base + f"/rows/{row['id']}/days/2026-10-12"
    assert client.put(cell, json={"value": "12,5"}).status_code == 200
    assert (
        client.put(
            cell.replace("2026-10-12", "2026-11-12"), json={"value": "Дежурство"}
        ).status_code
        == 200
    )
    configure(client, first, tab, table_format="list", period_mode="none")
    assert client.put(cell, json={"value": "3"}).status_code == 409
    configure(client, first, tab, table_format="calendar", period_mode="range")
    assert client.get(base + "/rows?from=2026-10-01&to=2026-10-31").json()[0][
        "calendar_values"
    ] == {
        "2026-10-12": "12,5",
        "2026-11-12": "Дежурство",
    }
    assert client.put(cell, json={"value": ""}).status_code == 200
    assert "2026-10-12" not in client.get(base + "/rows").json()[0]["calendar_values"]
    copied = client.post(
        f"/api/dormitories/{second}/tabs", json={"name": "Копия", "source_tab_id": tab["id"]}
    ).json()
    assert copied["options"]["table_format"] == "calendar"
    assert client.get(f"/api/dormitories/{second}/tabs/{copied['id']}/rows").json() == []


def test_template_remaps_date_column_and_retains_options(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    first, second = create_dormitory(client), create_dormitory(client, "Южное")
    tab = create(client, first, period_mode="month", clear_list=True, show_dates=False)
    copied = client.post(
        f"/api/dormitories/{second}/tabs", json={"name": "Копия", "source_tab_id": tab["id"]}
    ).json()
    assert copied["options"]["date_column_id"] != tab["options"]["date_column_id"]
    assert copied["options"]["clear_list"] is True
    saved = client.post("/api/dormitory-templates", json={"dormitory_id": first, "name": "Образец"})
    assert saved.status_code == 201, saved.text
    created = client.post(
        "/api/dormitories",
        json={
            "name": "Из шаблона",
            "client_name": "Клиент",
            "structure_template_id": saved.json()["id"],
        },
    )
    assert created.status_code == 201, created.text
    restored = client.get(f"/api/dormitories/{created.json()['id']}/tabs").json()[0]
    assert restored["options"]["date_column_id"] not in [
        tab["options"]["date_column_id"],
        copied["options"]["date_column_id"],
    ]
    assert restored["options"]["show_dates"] is False


def test_settings_choose_new_date_column_atomically_and_reject_invalid_column(
    client: TestClient,
    db_session: Session,
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    tab = create(client, dorm, period_mode="range")
    base = f"/api/dormitories/{dorm}"
    snapshot = client.get(base + "/settings").json()
    cols = [
        {key: col[key] for key in ("id", "name", "kind", "options", "archived")}
        for col in snapshot["tables"][tab["table_key"]]
    ]
    cols.append({"name": "Выезд", "kind": "date", "archived": False, "options": []})
    payload = {
        "revision": snapshot["revision"],
        "tabs": [
            {
                "key": tab["table_key"],
                "name": tab["name"],
                "options": tab["options"],
                "date_column_name": "Выезд",
            }
        ],
        "tables": [{"key": tab["table_key"], "columns": cols}],
    }
    response = client.put(base + "/settings", json=payload)
    assert response.status_code == 200, response.text
    data = response.json()
    chosen = next(col for col in data["tables"][tab["table_key"]] if col["name"] == "Выезд")
    assert data["tabs"][0]["options"]["date_column_id"] == chosen["id"]
    payload["revision"] = data["revision"]
    payload["tables"] = []
    payload["tabs"][0]["date_column_name"] = "Несуществующий столбец"
    assert client.put(base + "/settings", json=payload).status_code == 422
    assert client.get(base + "/settings").json()["revision"] == data["revision"]
