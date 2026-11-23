"""Серверная страница персонала: фильтры, порядок и объём ответа (#247).

Проверки повторяют то, что раньше делал браузер над полной выборкой:
`filterPeople` и `columnFilterPredicate`. Эталонные значения здесь — не «сколько
получилось», а правила клиента: кто попадает в `current`, что считается концом
вахты, как сравниваются условия по столбцам.
"""

import json
from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import event as sa_event
from sqlalchemy.orm import Session

from app.models.table_column import TableColumn
from app.personnel import today
from app.schemas.personnel import BlockPreview
from tests.conftest import sign_in
from tests.test_personnel import API, create, workspace
from tests.test_reports import create_dormitory
from tests.test_table_columns import add_column

PAGE = API + "/employees"
KB = 1024


def person(name: str, number: str, phone: str = "") -> dict[str, Any]:
    return {"full_name": name, "personnel_number": number, "phone": phone}


def page(client: TestClient, **params: Any) -> dict[str, Any]:
    response = client.get(PAGE, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def names(data: dict[str, Any]) -> list[str]:
    return [item["full_name"] for item in data["items"]]


def test_pages_cover_the_whole_list_without_gaps_or_repeats(
    client: TestClient, db_session: Session
) -> None:
    """`total` равен числу людей, страницы вместе дают весь список без повторов."""
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    listed = ["Яблоков Пётр", "Ёлкин Иван", "Абрамов Олег", "Ежов Лев", "Иванова Анна"]
    for index, name in enumerate(listed):
        create(client, dorm, fields=person(name, f"Т-{index}", f"+7 900 000 00 0{index}"))
    first = page(client, per_page=2)
    assert first["total"] == len(listed)
    assert first["pages"] == 3 and first["page"] == 1 and first["per_page"] == 2
    seen: list[str] = []
    for number in range(1, first["pages"] + 1):
        part = page(client, per_page=2, page=number)
        assert part["total"] == len(listed) and part["page"] == number
        assert len(part["items"]) <= 2
        seen.extend(item["id"] for item in part["items"])
    assert len(seen) == len(set(seen)) == len(listed)
    # За пределами последней страницы список пуст, но счётчики те же.
    empty = page(client, per_page=2, page=99)
    assert empty["items"] == [] and empty["total"] == len(listed)
    # Порядок клиента — русский алфавит, а не коды символов.
    assert names(page(client, per_page=50)) == [
        "Абрамов Олег",
        "Ежов Лев",
        "Ёлкин Иван",
        "Иванова Анна",
        "Яблоков Пётр",
    ]


def test_shift_filters_repeat_the_client_rules(client: TestClient, db_session: Session) -> None:
    """`current` — есть текущая запись, `ending` — вахта кончается в `days` дней."""
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    create(
        client,
        dorm,
        fields=person("Петров Пётр", "Т-1"),
        values={"shift_end": str(today() + timedelta(days=3))},
    )
    create(
        client,
        dorm,
        fields=person("Сидоров Иван", "Т-2"),
        values={"shift_end": str(today() + timedelta(days=30))},
    )
    # Строка оттока: карточка есть, текущего проживания нет.
    create(client, dorm, fields=person("Ушедший Олег", "Т-3"), table="outflow")
    everyone = page(client, per_page=50)
    assert everyone["total"] == 3
    assert names(page(client, filter="current", per_page=50)) == ["Петров Пётр", "Сидоров Иван"]
    assert names(page(client, filter="ending")) == ["Петров Пётр"]
    assert page(client, filter="ending", days=0)["total"] == 0
    assert page(client, filter="ending", days=30)["total"] == 2
    # Порядок при `ending` — по раннему концу вахты.
    assert names(page(client, filter="ending", days=30)) == ["Петров Пётр", "Сидоров Иван"]


def test_dormitory_scope_and_search_narrow_the_page(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    north, south = create_dormitory(client), create_dormitory(client, "Южное")
    create(client, north, fields=person("Ким Анна", "Т-1", "+7 (912) 345-67-89"))
    create(client, south, fields=person("Ли Олег", "Т-2", "+7 900 111 22 33"))
    assert page(client, dormitory=south)["total"] == 1
    assert page(client, scope=[north])["total"] == 1
    assert page(client, query="ким")["total"] == 1
    assert page(client, query="3456789")["total"] == 1
    assert page(client, query="Т-2")["total"] == 1
    assert page(client, query="никого")["total"] == 0
    # Чужое общежитие не расширяет область организации.
    assert page(client, dormitory=south, scope=[north])["total"] == 0


def test_column_conditions_filter_like_the_client(client: TestClient, db_session: Session) -> None:
    """Условия по столбцам: стандартное поле, столбец таблицы и неизвестное поле."""
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    base = f"/api/dormitories/{dorm}/tables/residents"
    column = add_column(client, base, "Статус допуска")
    allowed = column["options"][0]["id"]
    first = create(client, dorm, fields=person("Первый Иван", "Т-1"))
    create(client, dorm, fields=person("Второй Иван", "Т-2"))
    assert (
        client.put(
            f"{base}/rows/{first['row_id']}/cells/{column['id']}", json={"value": allowed}
        ).status_code
        == 200
    )
    stored = db_session.get(TableColumn, column["id"])
    assert stored is not None and stored.name == "Статус допуска"
    table_field = "source:residents:статус допуска:select"
    rules = [
        {"field": "residence_status", "operator": "equals", "value": "Проживает"},
        {"field": table_field, "operator": "equals", "value": "Сбежал"},
    ]
    assert names(page(client, column_filters=json.dumps(rules, ensure_ascii=False))) == [
        "Первый Иван"
    ]
    # Условия одной таблицы проверяются по одной и той же строке-источнику.
    conflicting = [rules[1], {"field": table_field, "operator": "equals", "value": "Уволился"}]
    assert page(client, column_filters=json.dumps(conflicting, ensure_ascii=False))["total"] == 0
    # Неизвестное поле не проходит ни у кого — как `columnFilterPredicate` в браузере.
    assert page(client, column_filters='[{"field": "unknown", "operator": "empty"}]')["total"] == 0
    # Пустое условие сравнения ничего не фильтрует.
    assert (
        page(client, column_filters='[{"field": "full_name", "operator": "contains"}]')["total"]
        == 2
    )
    for broken in ('{"field": "full_name"}', '[{"field": "full_name", "operator": "unsupported"}]'):
        assert client.get(PAGE, params={"column_filters": broken}).status_code == 422


def test_page_response_stays_small_on_a_long_list(client: TestClient, db_session: Session) -> None:
    """Ответ страницы не зависит от числа сотрудников: тело в пределах ~50 КБ."""
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    for index in range(60):
        create(
            client,
            dorm,
            fields=person(f"Сотрудник {index:02d}", f"Т-{index:03d}", f"+7 900 000 {index:04d}"),
            values={"shift_end": str(today() + timedelta(days=index % 7))},
        )
    response = client.get(PAGE, params={"per_page": 20})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 60 and len(body["items"]) == 20
    assert len(response.content) <= 50 * KB
    frame = client.get(API, params={"employees": "none"})
    assert frame.status_code == 200
    assert frame.json()["employees"] == []
    assert len(frame.content) <= 50 * KB


def test_query_count_does_not_grow_with_the_page(client: TestClient, db_session: Session) -> None:
    """Номер страницы не добавляет запросов: список собирается один раз."""
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    for index in range(12):
        create(client, dorm, fields=person(f"Сотрудник {index:02d}", f"Т-{index:03d}"))
    bind = db_session.get_bind()
    statements: list[str] = []

    def before(*args: Any) -> None:
        statements.append("sql")

    sa_event.listen(bind, "before_cursor_execute", before)
    try:
        first = page(client, per_page=5, page=1)
        statements.clear()
        page(client, per_page=5, page=2)
        second = len(statements)
        statements.clear()
        page(client, per_page=5, page=3)
        third = len(statements)
    finally:
        sa_event.remove(bind, "before_cursor_execute", before)
    assert first["total"] == 12
    assert second == third > 0


def test_workspace_frame_without_employees_keeps_blocks(
    client: TestClient, db_session: Session
) -> None:
    """`?employees=none` отдаёт рамку поверхности и данные блоков вместо карточек."""
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    end = today() + timedelta(days=3)
    create(client, dorm, values={"shift_end": str(end)})
    full = workspace(client)
    frame = client.get(API, params={"employees": "none"}).json()
    for key in ("today", "dormitories", "source_columns", "arrival_plans", "plans", "preferences"):
        assert frame[key] == full[key], key
    assert frame["arrival_settings"] == full["arrival_settings"]
    assert "block_previews" not in full
    previews = [BlockPreview.model_validate(item) for item in frame["block_previews"]]
    assert [item.kind for item in previews] == ["plans", "residents", "ending", "contacts"]
    residents, ending = previews[1], previews[2]
    assert residents.count == 1 and ending.count == 1
    assert ending.items[0].id == full["employees"][0]["id"]
    assert [(item.date, item.count) for item in ending.events] == [(str(end), 1)]
    assert [
        (item.id, item.name, item.client_name, item.is_archived, item.count)
        for item in residents.dorms
    ] == [(dorm, "Северное", "Стройкомплект", False, 1)]
    # Превью ограничено `limit` блока, а не размером страницы.
    assert all(len(item.items) <= 4 for item in previews)


def test_block_previews_keep_the_page_order(client: TestClient, db_session: Session) -> None:
    """Блоки отдают людей в том же порядке, что страница, а не в порядке `id`.

    До правки `block_previews` брал отфильтрованные карточки как есть — то есть
    в порядке `id` — и блок «Проживающий персонал» показывал не тех людей, чем
    список под ним. Клиент брал эти карточки из `filterPeople`, а тот сортирует
    по ФИО (`helpers.ts:123-135`).
    """
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    # Яблоков заведён первым, поэтому порядок `id` и порядок по ФИО расходятся.
    create(client, dorm, fields=person("Яблоков Пётр", "Т-1"))
    create(client, dorm, fields=person("Абрамов Иван", "Т-2"))
    frame = client.get(API, params={"employees": "none"}).json()
    previews = [BlockPreview.model_validate(item) for item in frame["block_previews"]]
    residents = next(item for item in previews if item.kind == "residents")
    assert [item.full_name for item in residents.items] == ["Абрамов Иван", "Яблоков Пётр"]
    assert [item.id for item in residents.items] == [item["id"] for item in page(client)["items"]]
