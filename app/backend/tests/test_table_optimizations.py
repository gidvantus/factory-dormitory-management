"""Рабочие таблицы: оформление, сохранение порядка и безопасная смена типа."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.table_column import TableColumn
from tests.conftest import add_colleague, login, sign_in
from tests.test_reports import create_dormitory, create_row
from tests.test_table_exchange import filled, upload


def state(**patch: Any) -> dict[str, Any]:
    return {"rows": [], "columns": [], "row_colors": {}, "column_colors": {}, **patch}


def test_view_persists_is_shared_within_table_and_rejects_stale_save(
    client: TestClient, db_session: Session
) -> None:
    owner = sign_in(client, db_session)
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}"
    columns = client.get(base + "/tables/residents/columns").json()
    order = [str(column["id"]) for column in reversed(columns)]
    view = base + "/table-views/residents"
    assert client.get(view).json() == {"revision": 0, "state": state()}
    payload = {
        "revision": 0,
        "state": state(
            columns=order,
            rows=["3", "1"],
            row_colors={"3": "mint"},
            column_colors={order[0]: "peach"},
        ),
    }
    result = client.put(view, json=payload)
    assert result.status_code == 200, result.text
    assert client.get(view).json() == result.json()
    assert result.json()["revision"] == 1
    assert [
        str(column["id"]) for column in client.get(base + "/tables/residents/columns").json()
    ] == order
    assert client.put(view, json=payload).status_code == 409
    stale = {"revision": 0, "state": state(columns=list(reversed(order)))}
    assert client.put(view, json=stale).status_code == 409
    assert [
        str(column["id"]) for column in client.get(base + "/tables/residents/columns").json()
    ] == order
    assert client.get(base + "/table-views/inflow").json()["state"] == state()
    other = create_dormitory(client, "Другое")
    assert client.get(f"/api/dormitories/{other}/table-views/residents").json()["revision"] == 0
    assert owner.active_organization_id is not None
    colleague = add_colleague(db_session, owner.active_organization_id)
    assert login(client, colleague.email).status_code == 200
    assert client.get(view).json() == result.json()
    sign_in(client, db_session, email="another-owner@example.com")
    assert client.get(view).status_code == 404
    assert client.put(view, json=payload).status_code == 404


def test_zoom_is_personal_and_separate_from_shared_table_view(
    client: TestClient, db_session: Session
) -> None:
    owner = sign_in(client, db_session)
    first = create_dormitory(client)
    second = create_dormitory(client, "Другое")
    view = f"/api/dormitories/{first}/table-views/report"
    zoom = view + "/zoom"
    assert client.get(zoom).json() == {"percent": 100}
    assert client.put(zoom, json={"percent": 130}).json() == {"percent": 130}
    assert client.get(view).json() == {"revision": 0, "state": state()}
    assert client.get(view.replace("report", "residents") + "/zoom").json() == {"percent": 100}
    assert client.get(f"/api/dormitories/{second}/table-views/report/zoom").json() == {
        "percent": 100
    }
    personnel_zoom = "/api/personnel/table-views/employees/zoom"
    assert client.put(personnel_zoom, json={"percent": 80}).json() == {"percent": 80}
    assert client.get(zoom).json() == {"percent": 130}
    assert client.put(zoom, json={"percent": 201}).status_code == 422

    assert owner.active_organization_id is not None
    colleague = add_colleague(db_session, owner.active_organization_id)
    assert login(client, colleague.email).status_code == 200
    assert client.get(zoom).json() == {"percent": 100}
    assert client.get(personnel_zoom).json() == {"percent": 100}
    assert client.put(zoom, json={"percent": 90}).json() == {"percent": 90}
    assert login(client, owner.email).status_code == 200
    assert client.get(zoom).json() == {"percent": 130}
    assert client.put(zoom, json={"percent": 100}).json() == {"percent": 100}
    assert client.get(zoom).json() == {"percent": 100}


def test_view_validates_colors_and_unknown_tables(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    view = f"/api/dormitories/{dorm}/table-views/"
    assert (
        client.put(
            view + "residents", json={"revision": 0, "state": state(row_colors={"1": "red"})}
        ).status_code
        == 422
    )
    assert (
        client.put(
            view + "residents", json={"revision": 0, "state": state(columns=["1", "1"])}
        ).status_code
        == 422
    )
    assert client.put(view + "unknown", json={"revision": 0, "state": state()}).status_code == 422


@pytest.mark.parametrize("kind", ["text", "number", "date", "checkbox", "select"])
def test_empty_custom_column_can_change_type_and_new_columns_append(
    client: TestClient, db_session: Session, kind: str
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    path = f"/api/dormitories/{dorm}/tables/residents/columns"
    before = client.get(path).json()
    new = client.post(
        path, json={"name": "Проверка типа", "kind": "number" if kind == "text" else "text"}
    ).json()
    assert new["position"] > max(column["position"] for column in before)
    result = client.patch(
        f"{path}/{new['id']}",
        json={
            "name": new["name"],
            "kind": kind,
            "options": [{"label": "Первый"}] if kind == "select" else [],
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["kind"] == kind
    assert result.json()["id"] == new["id"]


@pytest.mark.parametrize("value", ["Сведения", "0", False])
def test_type_change_never_loses_existing_values(
    client: TestClient, db_session: Session, value: Any
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    path = f"/api/dormitories/{dorm}/tables/residents/columns"
    column = client.post(
        path, json={"name": "Заполненный", "kind": "checkbox" if value is False else "text"}
    ).json()
    # Запись вне видимого периода тоже блокирует изменение формата.
    from app.models.resident import Resident

    db_session.add(Resident(dormitory_id=dorm, custom_values={str(column["id"]): value}))
    db_session.commit()
    result = client.patch(f"{path}/{column['id']}", json={"name": "Заполненный", "kind": "date"})
    assert result.status_code == 409
    stored = db_session.get(TableColumn, column["id"])
    assert stored is not None
    assert stored.kind == column["kind"]


def test_report_drag_order_preserves_formulas(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    report = f"/api/dormitories/{dorm}/report"
    first = create_row(client, report, "Основа")
    formula = create_row(client, report, "Результат", "=[Основа]*2")
    assert (
        client.put(f"{report}/rows/{first}/cells/2026-11-05", json={"value": "7"}).status_code
        == 204
    )
    saved = client.put(
        f"/api/dormitories/{dorm}/table-views/report",
        json={"revision": 0, "state": state(rows=[str(formula), str(first)])},
    )
    assert saved.status_code == 200, saved.text
    rows = client.get(report + "?from=2026-11-05&to=2026-11-05").json()["rows"]
    assert [row["id"] for row in rows][:2] == [formula, first]
    assert rows[0]["values"]["2026-11-05"] == "14"


@pytest.mark.parametrize("table", ["residents", "inflow", "outflow"])
def test_excel_import_shows_newest_rows_first_in_working_table(
    client: TestClient, db_session: Session, table: str
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    columns = client.get(f"/api/dormitories/{dorm}/tables/{table}/columns").json()
    writable = [
        column
        for column in columns
        if column["kind"] not in ("action", "hostel") and not column["archived"]
    ]
    names = [f"Работник {number}" for number in range(1, 7)]
    rows = [
        [name if column["builtin_key"] == "full_name" else None for column in writable]
        for name in names
    ]
    path = f"/api/dormitories/{dorm}/data-transfer/{table}"
    response = upload(client, path, filled(client, path, rows))
    assert response.status_code == 200, response.text
    query = "?month=2026-11-01" if table == "residents" else "?from=2026-11-01&to=2026-11-30"
    result = client.get(f"/api/dormitories/{dorm}/{table}{query}")
    assert result.status_code == 200, result.text
    loaded = result.json()["residents"] if table == "residents" else result.json()
    # Импорт создаёт строки в последовательности файла, а список отдаёт записи по
    # убыванию идентификатора: новые строки показываются первыми, поэтому на
    # экране импортированный файл читается снизу вверх (docs/table-optimizations.md).
    # Экспорт xlsx при этом остаётся в прямом порядке файла.
    assert [row["full_name"] for row in loaded] == list(reversed(names))
