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
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import sql_diagnostics
from app.api.personnel import employees_page
from app.models.organization import OrganizationMember
from app.models.personnel import Employee
from app.models.resident import Resident
from app.models.table_column import TableColumn
from app.personnel import today
from app.personnel_page import ListCriteria
from app.personnel_query import Shifts, ordered_roots
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


def test_sql_count_does_not_grow_with_the_page_size(
    client: TestClient, db_session: Session
) -> None:
    """`per_page` меняет размер окна, а не число запросов (#251).

    До этой задачи страница собиралась из всех карточек организации, поэтому её
    цена росла с числом людей, а не с `per_page`. Здесь проверяется обратное:
    пять и пятьдесят строк стоят одинакового числа обращений к базе.

    Карточки кладутся прямо в сессию, а не через `POST /personnel/records`: подбор
    личности на шестидесяти подряд идущих созданиях — отдельная ветка контракта,
    и замеру запросов она не нужна.
    """
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    surnames = [
        "Абрамов",
        "Богданов",
        "Виноградов",
        "Григорьев",
        "Дорофеев",
        "Евсеев",
        "Желтов",
        "Зайцев",
        "Игнатов",
        "Кузнецов",
        "Лебедев",
        "Морозов",
        "Никитин",
        "Орлов",
        "Петухов",
        "Романов",
        "Соколов",
        "Тимофеев",
        "Устинов",
        "Фомин",
        "Хромов",
        "Цветков",
        "Чернов",
        "Шилов",
        "Щукин",
        "Юдин",
        "Яковлев",
    ]
    people = [
        Employee(
            full_name=f"{surnames[index % len(surnames)]}{'а' if index >= len(surnames) else ''} "
            f"Иван",
            personnel_number=f"Т-{index:03d}",
            identity_status="confirmed",
        )
        for index in range(60)
    ]
    db_session.add_all(people)
    db_session.flush()
    db_session.add_all(
        Resident(dormitory_id=dorm, employee_id=employee.id, full_name=employee.full_name)
        for employee in people
    )
    db_session.commit()
    bind = db_session.get_bind()
    statements: list[str] = []

    def before(*args: Any) -> None:
        statements.append("sql")

    sa_event.listen(bind, "before_cursor_execute", before)
    try:
        statements.clear()
        small = page(client, per_page=5)
        few = len(statements)
        statements.clear()
        big = page(client, per_page=50)
        many = len(statements)
    finally:
        sa_event.remove(bind, "before_cursor_execute", before)
    assert small["total"] == big["total"] == 60
    assert few == many > 0


def test_page_route_marks_the_serialize_stage(client: TestClient, db_session: Session) -> None:
    """Сборка тела страницы — отдельный этап разбивки (#251, шаг 0).

    Без разметки время `json.dumps` попадало в «прочее», и по событию
    `slow_sql_request` нельзя было понять, сколько стоит тело, а сколько —
    выборки: остаток был непрозрачным.
    """
    user = sign_in(client, db_session)
    membership = db_session.scalars(
        select(OrganizationMember).where(OrganizationMember.user_id == user.id)
    ).first()
    assert membership is not None

    token = sql_diagnostics.start_request("probe")
    try:
        response = employees_page(
            user,
            membership,
            db_session,
            filter="all",
            dormitory=None,
            scope=None,
            days=5,
            query="",
            column_filters="",
            page=1,
            per_page=20,
        )
    finally:
        request_sql = sql_diagnostics.current()
        sql_diagnostics.finish_request(token)

    assert request_sql is not None
    assert "serialize" in request_sql.stages_ms
    assert json.loads(response.body)["total"] == 0


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
    # Сводка нужна только рамке: полный ответ сохраняет прежнюю форму.
    assert "counts" not in full
    assert set(frame["counts"]) == {"all", "current", "ending"}
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


def test_workspace_frame_counts_match_the_page(client: TestClient, db_session: Session) -> None:
    """Сводка в рамке совпадает с `total` одноимённых страниц (#247).

    Числа «Персонал N», «Проживают сейчас» и «Завершают вахту» считались в браузере
    по всему массиву карточек; при `employees=none` массива нет, поэтому их отдаёт
    рамка. Считаются они теми же правилами, что и страница, — значит обязаны давать
    те же числа, что `total` соответствующего фильтра.
    """
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
    frame = client.get(API, params={"employees": "none"}).json()
    assert frame["counts"] == {
        "all": page(client)["total"],
        "current": page(client, filter="current")["total"],
        "ending": page(client, filter="ending")["total"],
    }
    assert frame["counts"] == {"all": 3, "current": 2, "ending": 1}
    # Срок вахты — тот же параметр, что у страницы: от него зависит «Завершают вахту».
    longer = client.get(API, params={"employees": "none", "days": 30}).json()
    assert longer["counts"]["ending"] == page(client, filter="ending", days=30)["total"] == 2
    assert client.get(API, params={"employees": "none", "days": 0}).json()["counts"]["ending"] == 0
    # Общежитие сужает сводку так же, как страницу.
    narrowed = client.get(API, params={"employees": "none", "dormitory": dorm}).json()
    assert narrowed["counts"] == frame["counts"]


def test_block_previews_keep_the_page_order(client: TestClient, db_session: Session) -> None:
    """Превью блоков и страница отдают людей в одном порядке.

    Это сверка двух маршрутов на живых данных, а не страж регрессии: `Employee.id`
    — `uuid4()` (`app/models/personnel.py:25-26`), поэтому порядок карточек по `id`
    с порядком по ФИО совпадает случайно. Детерминированный страж — ниже,
    `test_block_previews_order_by_name_not_by_id`.
    """
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    create(client, dorm, fields=person("Яблоков Пётр", "Т-1"))
    create(client, dorm, fields=person("Абрамов Иван", "Т-2"))
    frame = client.get(API, params={"employees": "none"}).json()
    previews = [BlockPreview.model_validate(item) for item in frame["block_previews"]]
    residents = next(item for item in previews if item.kind == "residents")
    assert [item.full_name for item in residents.items] == ["Абрамов Иван", "Яблоков Пётр"]
    assert [item.id for item in residents.items] == [item["id"] for item in page(client)["items"]]


def test_ordered_roots_puts_the_name_first_and_id_last(
    db_session: Session,
) -> None:
    """Страж Б1: порядок задан ФИО и `id` — детерминированно, без `uuid4`.

    `id` в контракте — `uuid4()`, поэтому интеграционный тест на двух людях ловит
    возврат к сортировке по `id` только в половине прогонов. Здесь `id` заданы
    явно: первый по `id` — «Яблоков», первый по ФИО — «Абрамов», так что старая
    реализация падает при каждом запуске.
    """
    abramov = Employee(id="zzz", full_name="Абрамов Иван")
    yakobov = Employee(id="aaa00000-0000-0000-0000-000000000000", full_name="Яблоков Пётр")
    db_session.add_all([yakobov, abramov])
    db_session.commit()
    employees = {item.id: item for item in (yakobov, abramov)}
    order = ordered_roots(
        db_session,
        employees,
        set(employees),
        ListCriteria(),
        Shifts(frozenset(), frozenset(), {}, {}),
    )
    assert order == [abramov.id, yakobov.id]
    assert [employees[id].full_name for id in order] == ["Абрамов Иван", "Яблоков Пётр"]
    # Ё после е: порядок кодов символов совпадает с алфавитом клиента.
    assert employees[abramov.id].sort_name == "абрамов иван"
