"""Сохранение, серверный расчёт, доступ и конфликты настоящих маршрутов конструктора."""

from copy import deepcopy
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import add_colleague, login, sign_in
from tests.test_reports import create_dormitory

BASE = "/api/personnel/builder"


def column(
    id: str, name: str, kind: str = "number", rule: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {"id": id, "name": name, "kind": kind, **({"rule": rule} if rule else {})}


def formula(text: str, refs: dict[str, str]) -> dict[str, Any]:
    return {"mode": "formula", "expression": text, "refs": refs}


def link(source: str, field: str, **values: Any) -> dict[str, Any]:
    return {
        "mode": "link",
        "link": {"sourceId": source, "valueField": field, "operation": "sum", **values},
    }


def table(
    id: str, name: str, columns: list[dict[str, Any]], rows: list[dict[str, Any]]
) -> dict[str, Any]:
    return {"id": id, "name": name, "kind": "table", "columns": columns, "rows": rows}


def state(*tabs: dict[str, Any]) -> dict[str, Any]:
    return {"version": 3, "tabs": list(tabs), "defaultTab": "workspace"}


def payroll() -> dict[str, Any]:
    return state(
        table(
            "work",
            "Работа",
            [
                column("hours", "Часы"),
                column("rate", "Ставка"),
                column(
                    "pay",
                    "Оплата",
                    rule=formula("=([Часы]*[Ставка])+500", {"Часы": "hours", "Ставка": "rate"}),
                ),
            ],
            [{"id": "one", "values": {"hours": "8", "rate": "400"}}],
        )
    )


def test_storage_revision_and_canonical_empty_start(
    client: TestClient, db_session: Session
) -> None:
    assert client.get(BASE).status_code == 401
    sign_in(client, db_session)
    assert client.get(BASE).json() == {"revision": 0, "state": state()}
    payload = {"revision": 0, "state": payroll()}
    saved = client.put(BASE, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 1
    assert client.get(BASE).json() == saved.json()
    conflict = client.put(BASE, json=payload)
    assert conflict.status_code == 409
    assert client.get(BASE).json() == saved.json()


def test_colleagues_share_builder_with_revision_conflict(
    client: TestClient, db_session: Session
) -> None:
    owner = sign_in(client, db_session)
    assert owner.active_organization_id is not None
    colleague = add_colleague(db_session, owner.active_organization_id)
    first = client.put(BASE, json={"revision": 0, "state": payroll()})
    assert first.status_code == 200, first.text
    assert login(client, colleague.email).status_code == 200
    assert client.get(BASE).json() == first.json()
    changed = payroll()
    changed["tabs"][0]["rows"][0]["values"]["hours"] = "10"
    assert client.put(BASE, json={"revision": 1, "state": changed}).status_code == 200
    assert login(client, owner.email).status_code == 200
    stale = client.put(BASE, json={"revision": 1, "state": payroll()})
    assert stale.status_code == 409
    assert client.get(BASE).json()["state"]["tabs"][0]["rows"][0]["values"]["hours"] == "10"


def test_group_rules_are_templates_and_children_have_independent_sources(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    parent = payroll()["tabs"][0]
    parent["isGroup"] = True
    parent["columns"].append(column("total", "Итог группы", rule=link("tab:work", "hours")))
    child = deepcopy(parent)
    child.update(id="child", name="Расчёт подразделения", parentId="work", isGroup=False)
    child["columns"][-1]["rule"] = link("tab:child", "hours")
    parent["rows"] = []
    data = state(parent, child)
    saved = client.put(BASE, json={"revision": 0, "state": data})
    assert saved.status_code == 200, saved.text
    result = client.post(f"{BASE}/evaluate", json={"state": data, "tabId": "child"})
    assert result.status_code == 200, result.text
    assert result.json()["columns"]["one"] == {"pay": {"value": 3700}, "total": {"value": 8}}


def test_formula_preview_multistep_division_and_rename(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    data = payroll()

    def calculate() -> dict[str, Any]:
        response = client.post(
            f"{BASE}/evaluate",
            json={"state": data, "tabId": "work", "rowId": "one", "columnId": "pay"},
        )
        assert response.status_code == 200, response.text
        return response.json()["cell"]

    assert calculate() == {"value": 3700}
    data["tabs"][0]["columns"][0]["name"] = "Отработано"
    data["tabs"][0]["rows"][0]["values"]["hours"] = "10"
    assert calculate() == {"value": 4500}
    data["tabs"][0]["columns"][2]["rule"] = formula("=1/0", {})
    assert calculate()["error"] == "Деление на ноль"
    data["tabs"][0]["columns"][2]["rule"] = formula("=__import__('os')", {})
    assert client.put(BASE, json={"revision": 0, "state": data}).status_code == 422


def test_relations_aggregate_filter_cycles_and_dependencies(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    rates = table(
        "rates",
        "Ставки",
        [column("amount", "Сумма")],
        [{"id": "a", "values": {"amount": "350"}}, {"id": "b", "values": {"amount": "400"}}],
    )
    work = table(
        "work",
        "Итог",
        [
            column(
                "result",
                "Результат",
                rule=link(
                    "tab:rates",
                    "amount",
                    filters=[{"field": "amount", "operator": "from", "value": "360"}],
                ),
            )
        ],
        [{"id": "one", "values": {}}],
    )
    data = state(rates, work)
    response = client.post(f"{BASE}/evaluate", json={"state": data, "tabId": "work"})
    assert response.status_code == 200, response.text
    assert response.json()["columns"]["one"]["result"] == {"value": 400}
    saved = client.put(BASE, json={"revision": 0, "state": data})
    assert saved.status_code == 200, saved.text
    rates["columns"][0]["archived"] = True
    assert client.put(BASE, json={"revision": 1, "state": data}).status_code == 422
    rates["columns"][0]["archived"] = False
    rates["columns"][0]["rule"] = link("tab:work", "result")
    cycle = client.put(BASE, json={"revision": 1, "state": data})
    assert cycle.status_code == 422 and "Циклическая" in cycle.text


def test_calendar_per_day_and_stable_row_dependencies(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    days = table(
        "days",
        "План и факт",
        [column("name", "Показатель", "text")],
        [
            {
                "id": "plan",
                "name": "План",
                "values": {},
                "dayValues": {"2026-11-01": "8", "2026-11-02": "9"},
            },
            {
                "id": "fact",
                "name": "Факт",
                "values": {},
                "dayValues": {"2026-11-01": "7", "2026-11-02": "11"},
            },
            {
                "id": "delta",
                "name": "Разница",
                "values": {},
                "rule": formula("=[Факт]-[План]", {"Факт": "fact", "План": "plan"}),
            },
        ],
    )
    days["tableOptions"] = {"table_format": "calendar", "period_mode": "month"}
    data = state(days)
    result = client.post(
        f"{BASE}/evaluate",
        json={"state": data, "tabId": "days", "from": "2026-11-01", "to": "2026-11-02"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["days"]["delta"] == {
        "2026-11-01": {"value": -1},
        "2026-11-02": {"value": 2},
    }
    days["rows"] = days["rows"][1:]
    assert client.put(BASE, json={"revision": 0, "state": data}).status_code == 422


def test_organization_isolation_and_foreign_source_denied(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    assert client.put(BASE, json={"revision": 0, "state": payroll()}).status_code == 200
    sign_in(client, db_session, email="another-builder@example.com")
    assert client.get(BASE).json()["state"]["tabs"] == []
    catalog = client.get(f"{BASE}/sources")
    assert catalog.status_code == 200, catalog.text
    assert not any(source["id"].endswith(f":{dorm}") for source in catalog.json()["sources"])
    foreign = state(
        table(
            "foreign",
            "Чужой источник",
            [column("count", "Число", rule=link(f"report:{dorm}", "$value", sourceRowId="1"))],
            [],
        )
    )
    result = client.put(BASE, json={"revision": 0, "state": foreign})
    assert result.status_code == 422 and "недоступен" in result.text


def test_ambiguous_lookup_and_preserved_manual_values(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    data = payroll()
    source = deepcopy(data["tabs"][0])
    source["id"], source["name"] = "source", "Источник"
    source["rows"].append({"id": "two", "values": {"hours": "2", "rate": "100"}})
    data["tabs"].insert(0, source)
    data["tabs"][1]["columns"][2]["rule"] = link("tab:source", "pay", operation="lookup")
    result = client.post(f"{BASE}/evaluate", json={"state": data, "tabId": "work"})
    assert result.status_code == 200, result.text
    assert "найдено 2" in result.json()["columns"]["one"]["pay"]["error"]
    data["tabs"][1]["columns"][0]["archived"] = True
    data["tabs"][1]["columns"][2]["rule"] = formula("=5", {})
    saved = client.put(BASE, json={"revision": 0, "state": data})
    assert saved.status_code == 200, saved.text
    assert saved.json()["state"]["tabs"][1]["rows"][0]["values"]["hours"] == "8"
