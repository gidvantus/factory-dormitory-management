"""Настоящие маршруты: выбранная запись, копии, структура и границы доступа."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.cell_fill import FillResolver
from app.models.custom_tab import CustomTabEntry
from app.models.personnel import Employee
from app.models.resident import Resident
from app.table_data import record_value
from tests.conftest import sign_in
from tests.test_custom_tabs import tab
from tests.test_reports import create_dormitory


def setup(client: TestClient, db: Session) -> dict[str, Any]:
    sign_in(client, db)
    dorm = create_dormitory(client)
    source = tab(client, dorm, "Источник")
    base = f"/api/dormitories/{dorm}"
    response = client.post(
        f"{base}/tabs/{source['id']}/table",
        json={
            "columns": [
                {"name": "ФИО", "kind": "text"},
                {"name": "Заселение", "kind": "date"},
                {"name": "Сумма", "kind": "number"},
                {"name": "Отметка", "kind": "checkbox"},
            ]
        },
    )
    assert response.status_code == 201, response.text
    columns = client.get(f"{base}/tables/{source['table_key']}/columns").json()
    rows = []
    for day in ("2026-10-01", "2026-10-02"):
        row = client.post(f"{base}/tabs/{source['id']}/rows").json()
        for column, value in zip(columns, ["Иванов Алексей", day, "0", False], strict=False):
            saved = client.put(
                f"{base}/tables/{source['table_key']}/rows/{row['id']}/cells/{column['id']}",
                json={"value": value},
            )
            assert saved.status_code == 200, saved.text
        rows.append(row)
    target = tab(client, dorm, "Отпуск")
    fills = [
        {
            "name": "ФИО",
            "kind": "text",
            "client_id": -1,
            "fill": {"mode": "pick", "source": source["table_key"], "field": str(columns[0]["id"])},
        },
        {
            "name": "Дата заселения",
            "kind": "date",
            "fill": {
                "mode": "lookup",
                "source": source["table_key"],
                "field": str(columns[1]["id"]),
                "match_column_id": -1,
            },
        },
        {"name": "Начало отпуска", "kind": "date"},
    ]
    created = client.post(f"{base}/tabs/{target['id']}/table", json={"columns": fills})
    assert created.status_code == 201, created.text
    target_columns = client.get(f"{base}/tables/{target['table_key']}/columns").json()
    row = client.post(f"{base}/tabs/{target['id']}/rows").json()
    return {
        "base": base,
        "dorm": dorm,
        "source": source,
        "target": target,
        "columns": columns,
        "target_columns": target_columns,
        "rows": rows,
        "row": row,
    }


def choose(client: TestClient, data: dict[str, Any], source_id: int | None) -> dict[str, Any]:
    response = client.put(
        f"{data['base']}/cell-fill/{data['target']['table_key']}/rows/{data['row']['id']}/selection/{data['target_columns'][0]['id']}",
        json={"record_id": str(source_id) if source_id else None},
    )
    assert response.status_code == 200, response.text
    return response.json()


def listed(client: TestClient, data: dict[str, Any]) -> dict[str, Any]:
    response = client.get(f"{data['base']}/tabs/{data['target']['id']}/rows")
    assert response.status_code == 200, response.text
    return response.json()[0]


def update_rule(client: TestClient, data: dict[str, Any], patch: dict[str, Any]) -> None:
    column = data["target_columns"][1]
    response = client.patch(
        f"{data['base']}/tables/{data['target']['table_key']}/columns/{column['id']}",
        json={"name": column["name"], "kind": column["kind"], "fill": {**column["fill"], **patch}},
    )
    assert response.status_code == 200, response.text
    data["target_columns"][1] = response.json()


def test_live_values_ids_manual_values_and_server_write_protection(
    client: TestClient, db_session: Session
) -> None:
    data = setup(client, db_session)
    key = str(data["target_columns"][1]["id"])
    assert choose(client, data, data["rows"][0]["id"])["fill_values"][key] == "2026-10-01"
    assert choose(client, data, data["rows"][1]["id"])["fill_values"][key] == "2026-10-02"
    assert choose(client, data, None)["fill_values"][key] is None
    choose(client, data, data["rows"][0]["id"])
    path = (
        f"{data['base']}/tables/{data['source']['table_key']}/rows/"
        f"{data['rows'][0]['id']}/cells/{data['columns'][1]['id']}"
    )
    assert client.put(path, json={"value": "2026-10-07"}).status_code == 200
    assert listed(client, data)["fill_values"][key] == "2026-10-07"
    assert client.put(path, json={"value": None}).status_code == 200
    assert listed(client, data)["fill_values"][key] is None
    blocked = client.put(
        f"{data['base']}/tables/{data['target']['table_key']}/rows/{data['row']['id']}/cells/{key}",
        json={"value": "2026-12-01"},
    )
    assert blocked.status_code == 409
    manual = str(data["target_columns"][2]["id"])
    assert (
        client.put(
            f"{data['base']}/tables/{data['target']['table_key']}/rows/{data['row']['id']}/cells/{manual}",
            json={"value": "2026-11-09"},
        ).status_code
        == 200
    )
    assert listed(client, data)["custom_values"][manual] == "2026-11-09"


def test_copy_survives_source_change_and_deletion_and_reselects(
    client: TestClient, db_session: Session
) -> None:
    data = setup(client, db_session)
    choose(client, data, data["rows"][0]["id"])
    update_rule(client, data, {"update": "copy"})
    key = str(data["target_columns"][1]["id"])
    second_copy = client.post(
        f"{data['base']}/tables/{data['target']['table_key']}/columns",
        json={"name": "Вторая копия", "kind": "date", "fill": data["target_columns"][1]["fill"]},
    )
    assert second_copy.status_code == 201, second_copy.text
    assert listed(client, data)["fill_values"][str(second_copy.json()["id"])] == "2026-10-01"
    assert (
        client.delete(
            f"{data['base']}/tabs/{data['source']['id']}/rows/{data['rows'][0]['id']}"
        ).status_code
        == 204
    )
    row = listed(client, data)
    assert row["fill_values"][key] == "2026-10-01"
    assert str(data["target_columns"][0]["id"]) in row["fill_errors"]
    assert choose(client, data, data["rows"][1]["id"])["fill_values"][key] == "2026-10-02"
    assert choose(client, data, None)["fill_values"][key] is None


def test_manual_values_return_when_fill_is_disabled(
    client: TestClient, db_session: Session
) -> None:
    data = setup(client, db_session)
    column = data["target_columns"][2]
    url = f"{data['base']}/tables/{data['target']['table_key']}/columns/{column['id']}"
    cell = (
        f"{data['base']}/tables/{data['target']['table_key']}/rows/"
        f"{data['row']['id']}/cells/{column['id']}"
    )
    assert client.put(cell, json={"value": "2026-11-09"}).status_code == 200
    choose(client, data, data["rows"][0]["id"])
    payload = {
        "name": column["name"],
        "kind": column["kind"],
        "fill": data["target_columns"][1]["fill"],
    }
    assert client.patch(url, json=payload).status_code == 200
    assert listed(client, data)["fill_values"][str(column["id"])] == "2026-10-01"
    assert client.patch(url, json={**payload, "fill": None}).status_code == 200
    assert listed(client, data)["custom_values"][str(column["id"])] == "2026-11-09"


def test_dependencies_protect_sources_and_selection_columns(
    client: TestClient, db_session: Session
) -> None:
    data = setup(client, db_session)
    for table, column in [
        (data["source"], data["columns"][1]),
        (data["target"], data["target_columns"][0]),
    ]:
        response = client.delete(
            f"{data['base']}/tables/{table['table_key']}/columns/{column['id']}"
        )
        assert response.status_code == 409, response.text


def test_sources_only_current_dormitory_and_personnel_scope(
    client: TestClient, db_session: Session
) -> None:
    data = setup(client, db_session)
    other = create_dormitory(client, "Другое")
    other_source = tab(client, other, "Чужая таблица")
    catalog = client.get(f"{data['base']}/cell-fill/sources").json()
    assert "personnel" in {item["key"] for item in catalog}
    assert other_source["table_key"] not in {item["key"] for item in catalog}
    assert client.get(
        f"{data['base']}/cell-fill/records",
        params={"source": other_source["table_key"], "field": str(data["columns"][0]["id"])},
    ).status_code in (409, 422)
    records = client.get(
        f"{data['base']}/cell-fill/records",
        params={
            "source": data["source"]["table_key"],
            "field": str(data["columns"][0]["id"]),
            "limit": 1,
        },
    ).json()
    assert len(records["records"]) == 1
    assert records["has_more"]
    assert "Запись №" in records["records"][0]["detail"]


def test_personnel_source_uses_visible_employee_and_keeps_zero_false(
    client: TestClient, db_session: Session
) -> None:
    data = setup(client, db_session)
    employee = Employee(full_name="Сотрудник организации", personnel_number="100")
    hidden = Employee(full_name="Нет видимых записей")
    db_session.add_all([employee, hidden])
    db_session.flush()
    db_session.add(
        Resident(dormitory_id=data["dorm"], employee_id=employee.id, full_name=employee.full_name)
    )
    db_session.commit()
    result = client.get(
        f"{data['base']}/cell-fill/records", params={"source": "personnel", "field": "full_name"}
    )
    assert result.status_code == 200, result.text
    assert [item["id"] for item in result.json()["records"]] == [employee.id]
    for kind, source_index, expected in [("number", 2, "0"), ("checkbox", 3, False)]:
        created = client.post(
            f"{data['base']}/tables/{data['target']['table_key']}/columns",
            json={
                "name": kind,
                "kind": kind,
                "fill": {
                    "mode": "lookup",
                    "source": data["source"]["table_key"],
                    "field": str(data["columns"][source_index]["id"]),
                    "match_column_id": data["target_columns"][0]["id"],
                },
            },
        )
        assert created.status_code == 201, created.text
        values = choose(client, data, data["rows"][0]["id"])["fill_values"]
        assert values[str(created.json()["id"])] == expected


def test_report_reads_effective_values_and_batched_resolver(
    client: TestClient, db_session: Session
) -> None:
    data = setup(client, db_session)
    choose(client, data, data["rows"][0]["id"])
    row = db_session.get(CustomTabEntry, data["row"]["id"])
    assert row is not None
    resolver = FillResolver(db_session, data["dorm"])
    column = resolver.columns[data["target_columns"][1]["id"]]
    assert record_value(row, column, resolver) == "2026-10-01"
    assert str(column.id) not in row.custom_values


def test_template_remaps_links_without_selected_records(
    client: TestClient, db_session: Session
) -> None:
    from app.dormitory_templates import apply_snapshot, take_snapshot
    from app.models.dormitory import Dormitory

    data = setup(client, db_session)
    choose(client, data, data["rows"][0]["id"])
    snapshot = take_snapshot(db_session, data["dorm"])
    original = db_session.get(Dormitory, data["dorm"])
    assert original is not None
    target = Dormitory(
        name="Копия",
        client_name="Клиент",
        organization_id=original.organization_id,
        created_by_id=original.created_by_id,
    )
    db_session.add(target)
    db_session.flush()
    target_id = target.id
    apply_snapshot(db_session, target, snapshot)
    db_session.commit()
    resolver = FillResolver(db_session, target_id)
    picks = [col for col in resolver.columns.values() if col.fill and col.fill["mode"] == "pick"]
    lookups = [
        col for col in resolver.columns.values() if col.fill and col.fill["mode"] == "lookup"
    ]
    assert len(picks) == len(lookups) == 1
    assert picks[0].fill and lookups[0].fill
    assert lookups[0].fill["match_column_id"] == picks[0].id
    assert picks[0].fill["source"] != data["source"]["table_key"]
    assert resolver.columns[int(lookups[0].fill["field"])].dormitory_id == target_id
    assert resolver.source_records(picks[0].table_key) == {}


@pytest.mark.parametrize(
    "patch",
    [{"field": "full_name", "source": "personnel"}, {"match_column_id": 999999}, {"field": "-999"}],
)
def test_invalid_rules_rejected(
    client: TestClient, db_session: Session, patch: dict[str, Any]
) -> None:
    data = setup(client, db_session)
    column = data["target_columns"][1]
    response = client.patch(
        f"{data['base']}/tables/{data['target']['table_key']}/columns/{column['id']}",
        json={"name": column["name"], "kind": column["kind"], "fill": {**column["fill"], **patch}},
    )
    assert response.status_code == 422
    actual = client.get(f"{data['base']}/tables/{data['target']['table_key']}/columns").json()
    assert next(item for item in actual if item["id"] == column["id"])["fill"] == column["fill"]


def test_batch_settings_resolve_new_selector_and_remove_old_dependency(
    client: TestClient, db_session: Session
) -> None:
    data = setup(client, db_session)
    snapshot = client.get(f"{data['base']}/settings").json()
    columns = [
        {key: column[key] for key in ("id", "name", "kind", "options", "archived", "fill")}
        for column in snapshot["tables"][data["target"]["table_key"]]
    ]
    columns[0]["archived"] = True
    columns[1]["fill"] = {**columns[1]["fill"], "match_column_id": -10, "update": "copy"}
    columns.append(
        {"name": "Выбор человека", "kind": "text", "client_id": -10, "fill": columns[0]["fill"]}
    )
    saved = client.put(
        f"{data['base']}/settings",
        json={
            "revision": snapshot["revision"],
            "tables": [{"key": data["target"]["table_key"], "columns": columns}],
        },
    )
    assert saved.status_code == 200, saved.text
    actual = saved.json()["tables"][data["target"]["table_key"]]
    selector = next(column for column in actual if column["name"] == "Выбор человека")
    linked = next(column for column in actual if column["name"] == "Дата заселения")
    assert linked["fill"]["match_column_id"] == selector["id"]
    assert selector["id"] > 0
    data["target_columns"][0] = selector
    result = choose(client, data, data["rows"][0]["id"])
    assert result["fill_values"][str(linked["id"])] == "2026-10-01"


def test_period_filter_uses_linked_dates_and_handles_missing_source(
    client: TestClient, db_session: Session
) -> None:
    from app.models.custom_tab import CustomTab

    data = setup(client, db_session)
    target = db_session.get(CustomTab, data["target"]["id"])
    assert target is not None
    target.options = {"period_mode": "range", "date_column_id": data["target_columns"][1]["id"]}
    db_session.commit()
    choose(client, data, data["rows"][0]["id"])
    path = f"{data['base']}/tabs/{target.id}/rows"
    assert len(client.get(path, params={"from": "2026-10-01", "to": "2026-10-01"}).json()) == 1
    assert client.get(path, params={"from": "2026-10-02", "to": "2026-10-02"}).json() == []
    assert (
        client.delete(
            f"{data['base']}/tabs/{data['source']['id']}/rows/{data['rows'][0]['id']}"
        ).status_code
        == 204
    )
    response = client.get(path, params={"from": "2026-10-01", "to": "2026-10-01"})
    assert response.status_code == 200
    assert response.json() == []


def test_report_template_copies_cell_sources_with_new_identifiers(
    client: TestClient, db_session: Session
) -> None:
    from app.models.dormitory import Dormitory
    from app.models.report import ReportRow
    from app.table_data import restore_link, snapshot_link

    data = setup(client, db_session)
    report = ReportRow(
        dormitory_id=data["dorm"],
        name="Связанный отчёт",
        position=20,
        link={
            "table_key": data["target"]["table_key"],
            "column_id": data["target_columns"][1]["id"],
            "operator": "not_empty",
            "value": None,
            "date_column_id": data["target_columns"][1]["id"],
        },
    )
    snapshot = snapshot_link(db_session, report)
    assert snapshot and len(snapshot["fill_sources"]) == 1
    original = db_session.get(Dormitory, data["dorm"])
    assert original is not None
    target = Dormitory(
        name="Копия отчёта",
        client_name="Клиент",
        organization_id=original.organization_id,
        created_by_id=original.created_by_id,
    )
    db_session.add(target)
    db_session.flush()
    mapping: dict[int, int] = {}
    sources: dict[str, int] = {}
    restored = restore_link(db_session, target.id, snapshot, mapping, sources)
    assert restored
    resolver = FillResolver(db_session, target.id)
    column = resolver.columns[restored["column_id"]]
    assert column.fill and column.fill["source"] != data["source"]["table_key"]
    assert resolver.columns[int(column.fill["field"])].dormitory_id == target.id
    assert column.fill["match_column_id"] == mapping[data["target_columns"][0]["id"]]
    # Повторная строка шаблона переиспользует структуру, не меняя ID ещё раз.
    assert restore_link(db_session, target.id, snapshot, mapping, sources) == restored


def test_foreign_organization_cannot_read_or_choose_sources(
    client: TestClient, db_session: Session
) -> None:
    from app.models.dormitory import Dormitory
    from app.models.organization import Organization

    data = setup(client, db_session)
    organization = Organization(name="Другая организация")
    db_session.add(organization)
    db_session.flush()
    other = Dormitory(name="Недоступное", client_name="Клиент", organization_id=organization.id)
    db_session.add(other)
    db_session.flush()
    employee = Employee(full_name="Скрытый сотрудник")
    db_session.add(employee)
    db_session.flush()
    db_session.add(
        Resident(dormitory_id=other.id, employee_id=employee.id, full_name=employee.full_name)
    )
    db_session.commit()
    own_records = client.get(
        f"{data['base']}/cell-fill/records", params={"source": "personnel", "field": "full_name"}
    ).json()["records"]
    assert employee.id not in {item["id"] for item in own_records}
    base = f"/api/dormitories/{other.id}/cell-fill"
    assert client.get(base + "/sources").status_code == 404
    assert (
        client.get(
            base + "/records", params={"source": "personnel", "field": "full_name"}
        ).status_code
        == 404
    )
    assert client.get(base + f"/{data['target']['table_key']}/values").status_code == 404
    response = client.put(
        base
        + f"/{data['target']['table_key']}/rows/{data['row']['id']}"
        + f"/selection/{data['target_columns'][0]['id']}",
        json={"record_id": employee.id},
    )
    assert response.status_code == 404
