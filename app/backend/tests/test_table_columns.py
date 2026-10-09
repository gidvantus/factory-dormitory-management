"""Столбцы и связи: сохранность истории, область общежития, даты и пересчёт."""

from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.outflow import PersonnelOutflow
from app.models.report import ReportRow
from app.models.table_column import TableColumn
from tests.test_reports import create_dormitory, sign_in


def setup_table(client: TestClient, db_session: Session, table: str = "outflow") -> tuple[int, str]:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    return dorm, f"/api/dormitories/{dorm}/tables/{table}"


def add_column(
    client: TestClient, base: str, name: str = "Новая причина", kind: str = "select"
) -> dict[str, Any]:
    response = client.post(
        f"{base}/columns",
        json={
            "name": name,
            "kind": kind,
            "options": [{"label": "Сбежал"}, {"label": "Уволился"}] if kind == "select" else [],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_residents_settlement_action_updates_existing_columns_once(
    client: TestClient, db_session: Session
) -> None:
    _, base = setup_table(client, db_session, "residents")
    columns = client.get(f"{base}/columns").json()
    keys = [col["builtin_key"] for col in columns]
    assert keys.index("action_settlement") == keys.index("action_advance") + 1
    settlement = next(col for col in columns if col["builtin_key"] == "action_settlement")
    stored = db_session.get(TableColumn, settlement["id"])
    assert stored is not None
    db_session.delete(stored)
    db_session.commit()
    custom = add_column(client, base, "Комментарий", "text")
    updated = client.get(f"{base}/columns").json()
    keys = [col["builtin_key"] for col in updated]
    assert keys.index("action_settlement") == keys.index("action_advance") + 1
    assert next(col for col in updated if col["id"] == custom["id"])["name"] == "Комментарий"
    assert {col["id"] for col in columns if col["id"] != settlement["id"]} <= {
        col["id"] for col in updated
    }
    assert client.get(f"{base}/columns").json() == updated
    settlement = next(col for col in updated if col["builtin_key"] == "action_settlement")
    assert settlement["kind"] == "action"
    assert settlement["name"] == "Запись на расчёт"
    assert client.delete(f"{base}/columns/{settlement['id']}").status_code == 204
    assert next(
        col for col in client.get(f"{base}/columns").json() if col["id"] == settlement["id"]
    )["archived"]


def test_rename_archive_restore_keeps_values_and_ids(
    client: TestClient, db_session: Session
) -> None:
    dorm, base = setup_table(client, db_session)
    column = add_column(client, base)
    option = column["options"][0]["id"]
    row = client.post(f"/api/dormitories/{dorm}/outflow").json()
    cell = f"{base}/rows/{row['id']}/cells/{column['id']}"
    assert client.put(cell, json={"value": option}).status_code == 200
    column["options"][0]["label"] = "Самовольно ушёл"
    column["options"][0]["archived"] = True
    response = client.patch(
        f"{base}/columns/{column['id']}",
        json={
            "name": "Основание",
            "kind": "select",
            "options": column["options"],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["options"][0]["id"] == option
    assert client.delete(f"{base}/columns/{column['id']}").status_code == 204
    assert client.put(cell, json={"value": option}).status_code == 409
    assert client.post(f"{base}/columns/{column['id']}/restore").status_code == 200
    stored = client.get(f"/api/dormitories/{dorm}/outflow?from=2026-10-01&to=2026-10-31").json()[0]
    assert stored["custom_values"][str(column["id"])] == option
    another = client.post(f"/api/dormitories/{dorm}/outflow").json()
    assert (
        client.put(
            f"{base}/rows/{another['id']}/cells/{column['id']}", json={"value": option}
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    "table,endpoint",
    [
        ("residents", "residents"),
        ("inflow", "inflow"),
        ("outflow", "outflow"),
        ("advance", "payments/advance"),
        ("settlement", "payments/settlement"),
        ("archive", "tables/archive/rows"),
    ],
)
def test_all_tables_allow_builtin_removal_and_typed_cells(
    client: TestClient, db_session: Session, table: str, endpoint: str
) -> None:
    dorm, base = setup_table(client, db_session, table)
    builtin = client.get(f"{base}/columns").json()[0]
    assert client.delete(f"{base}/columns/{builtin['id']}").status_code == 204
    assert client.get(f"{base}/columns").json()[0]["archived"]
    row = client.post(f"/api/dormitories/{dorm}/{endpoint}").json()
    for kind, value, invalid in [
        ("text", "Примечание", True),
        ("number", "12.50", "NaN"),
        ("date", "2026-10-08", "2026-02-30"),
        ("checkbox", True, "true"),
    ]:
        column = add_column(client, base, kind, kind)
        cell = f"{base}/rows/{row['id']}/cells/{column['id']}"
        assert client.put(cell, json={"value": value}).status_code == 200
        assert client.put(cell, json={"value": invalid}).status_code == 422


def test_links_count_by_moscow_creation_day_and_feed_formulas(
    client: TestClient, db_session: Session
) -> None:
    dorm, base = setup_table(client, db_session)
    column = add_column(client, base)
    value = column["options"][0]["id"]
    rows = [client.post(f"/api/dormitories/{dorm}/outflow").json() for _ in range(3)]
    for index, row in enumerate(rows):
        db_row = db_session.get(PersonnelOutflow, row["id"])
        assert db_row is not None
        db_row.created_at = datetime(2026, 10, 8, 20 if index == 0 else 22, tzinfo=UTC)
        db_session.commit()
        assert (
            client.put(
                f"{base}/rows/{row['id']}/cells/{column['id']}", json={"value": value}
            ).status_code
            == 200
        )
    report = f"/api/dormitories/{dorm}/report"
    link = {"table_key": "outflow", "column_id": column["id"], "value": value}
    response = client.post(f"{report}/rows", json={"name": "Сбежал", "link": link})
    assert response.status_code == 201, response.text
    linked = response.json()
    assert (
        client.post(
            f"{report}/rows", json={"name": "Двойное", "formula": "=[Сбежал]*2"}
        ).status_code
        == 201
    )
    result = client.get(f"{report}?from=2026-10-08&to=2026-10-10").json()["rows"]
    by_name = {row["name"]: row for row in result}
    assert by_name["Сбежал"]["values"] == {"2026-10-08": "1", "2026-10-09": "2", "2026-10-10": "0"}
    assert by_name["Двойное"]["values"]["2026-10-09"] == "4"
    assert (
        client.put(
            f"{report}/rows/{linked['id']}/cells/2026-10-08", json={"value": "9"}
        ).status_code
        == 409
    )
    assert client.delete(f"{base}/columns/{column['id']}").status_code == 409
    # Editing the source and deleting a record immediately changes computed values.
    assert (
        client.put(
            f"{base}/rows/{rows[1]['id']}/cells/{column['id']}",
            json={"value": column["options"][1]["id"]},
        ).status_code
        == 200
    )
    assert client.delete(f"/api/dormitories/{dorm}/outflow/{rows[2]['id']}").status_code == 204
    values = client.get(f"{report}?from=2026-10-09&to=2026-10-09").json()["rows"]
    assert next(row for row in values if row["id"] == linked["id"])["values"]["2026-10-09"] == "0"


@pytest.mark.parametrize("custom", [False, True])
def test_filled_dates_count_all_arrivals_on_their_own_dates(
    client: TestClient, db_session: Session, custom: bool
) -> None:
    dorm, base = setup_table(client, db_session, "inflow")
    columns = client.get(f"{base}/columns").json()
    column = (
        add_column(client, base, "Дата приезда", "date")
        if custom
        else next(col for col in columns if col["builtin_key"] == "settlement_date")
    )
    entries = []
    for day in ("2026-10-01", "2026-10-01", "2026-10-02", None, "2026-11-01"):
        row = client.post(f"/api/dormitories/{dorm}/inflow").json()
        entries.append(row)
        if custom:
            response = client.put(
                f"{base}/rows/{row['id']}/cells/{column['id']}", json={"value": day}
            )
        else:
            response = client.patch(
                f"/api/dormitories/{dorm}/inflow/{row['id']}", json={"settlement_date": day}
            )
        assert response.status_code == 200, response.text
    report = f"/api/dormitories/{dorm}/report"
    response = client.post(
        f"{report}/rows",
        json={
            "name": "Приехал",
            "link": {
                "table_key": "inflow",
                "column_id": column["id"],
                "operator": "not_empty",
                "date_column_id": column["id"],
            },
        },
    )
    assert response.status_code == 201, response.text
    linked = response.json()
    assert linked["link"]["value"] is None
    result = client.get(f"{report}?from=2026-10-01&to=2026-10-03").json()["rows"][-1]
    assert result["errors"] == {}
    assert result["values"] == {"2026-10-01": "2", "2026-10-02": "1", "2026-10-03": "0"}
    # Moving an arrival date changes both days without changing the rule.
    row = entries[0]
    if custom:
        client.put(f"{base}/rows/{row['id']}/cells/{column['id']}", json={"value": "2026-10-02"})
    else:
        client.patch(
            f"/api/dormitories/{dorm}/inflow/{row['id']}", json={"settlement_date": "2026-10-02"}
        )
    values = client.get(f"{report}?from=2026-10-01&to=2026-10-03").json()["rows"][-1]["values"]
    assert values["2026-10-01"] == "1"
    assert values["2026-10-02"] == "2"


def test_event_date_links_and_dependency_guards(client: TestClient, db_session: Session) -> None:
    dorm, base = setup_table(client, db_session)
    columns = client.get(f"{base}/columns").json()
    reason = next(col for col in columns if col["builtin_key"] == "reason")
    day = next(col for col in columns if col["builtin_key"] == "departure_date")
    row = client.post(f"/api/dormitories/{dorm}/outflow").json()
    client.patch(
        f"/api/dormitories/{dorm}/outflow/{row['id']}",
        json={"reason": "Сбежал", "departure_date": "2026-10-01"},
    )
    report = f"/api/dormitories/{dorm}/report"
    linked = client.post(
        f"{report}/rows",
        json={
            "name": "Сбежал",
            "link": {
                "table_key": "outflow",
                "column_id": reason["id"],
                "value": "Сбежал",
                "date_column_id": day["id"],
            },
        },
    ).json()
    assert linked["link"] is not None
    assert (
        client.get(f"{report}?from=2026-10-01&to=2026-10-01").json()["rows"][-1]["values"][
            "2026-10-01"
        ]
        == "1"
    )
    assert client.delete(f"{base}/columns/{day['id']}").status_code == 409
    assert client.patch(f"{report}/rows/{linked['id']}", json={"formula": "=1"}).status_code == 422
    assert (
        client.patch(
            f"{report}/rows/{linked['id']}", json={"formula": "=1", "link": None}
        ).status_code
        == 200
    )
    assert client.delete(f"{base}/columns/{day['id']}").status_code == 204


def test_scope_validation_and_broken_link_is_error_not_zero(
    client: TestClient, db_session: Session
) -> None:
    dorm, base = setup_table(client, db_session)
    other = create_dormitory(client, "Другой")
    column = add_column(client, base)
    other_column = add_column(client, f"/api/dormitories/{other}/tables/outflow")
    row = client.post(f"/api/dormitories/{other}/outflow").json()
    assert (
        client.put(
            f"{base}/rows/{row['id']}/cells/{column['id']}",
            json={"value": column["options"][0]["id"]},
        ).status_code
        == 404
    )
    report = f"/api/dormitories/{dorm}/report"
    link = {
        "table_key": "outflow",
        "column_id": other_column["id"],
        "value": other_column["options"][0]["id"],
    }
    assert client.post(f"{report}/rows", json={"name": "Связь", "link": link}).status_code == 404
    link.update(column_id=column["id"], value=column["options"][0]["id"])
    response = client.post(f"{report}/rows", json={"name": "Связь", "link": link})
    db_row = db_session.get(ReportRow, response.json()["id"])
    assert db_row is not None
    db_row.link = {**link, "column_id": 999999}
    db_session.commit()
    result = client.get(f"{report}?from=2026-10-01&to=2026-10-01").json()["rows"][-1]
    assert not result["values"]
    assert "Проверьте связь" in result["errors"]["2026-10-01"]


def test_template_clones_link_columns_without_source_data(
    client: TestClient, db_session: Session
) -> None:
    dorm, base = setup_table(client, db_session)
    old_columns = client.get(f"{base}/columns").json()
    old_reason = next(col for col in old_columns if col["builtin_key"] == "reason")
    assert client.delete(f"{base}/columns/{old_reason['id']}").status_code == 204
    column = add_column(client, base, "Причина")
    date_column = add_column(client, base, "Дата события", "date")
    report = f"/api/dormitories/{dorm}/report"
    assert (
        client.post(
            f"{report}/rows",
            json={
                "name": "Сбежал",
                "link": {
                    "table_key": "outflow",
                    "column_id": column["id"],
                    "value": column["options"][0]["id"],
                    "date_column_id": date_column["id"],
                },
            },
        ).status_code
        == 201
    )
    template = client.post("/api/report-templates", json={"dormitory_id": dorm, "name": "Связи"})
    assert template.status_code == 201, template.text
    target = client.post(
        "/api/dormitories",
        json={"name": "Новый", "client_name": "Клиент", "template_id": template.json()["id"]},
    )
    assert target.status_code == 201, target.text
    new_id = target.json()["id"]
    copied = client.get(f"/api/dormitories/{new_id}/report?from=2026-10-01&to=2026-10-01").json()[
        "rows"
    ][-1]
    assert copied["link"]["column_id"] != column["id"]
    assert copied["link"]["date_column_id"] != date_column["id"]
    assert copied["values"] == {"2026-10-01": "0"}
    assert copied["errors"] == {}
    copied_columns = client.get(f"/api/dormitories/{new_id}/tables/outflow/columns").json()
    assert (
        len([col for col in copied_columns if col["name"] == "Причина" and not col["archived"]])
        == 1
    )
    assert next(col for col in copied_columns if col["builtin_key"] == "reason")["archived"]
