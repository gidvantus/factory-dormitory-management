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
    # Прогрев: первый запрос страницы в процессе поднимает ленивые справочники
    # (`table_import_jobs` читается один раз на процесс). Без прогрева это
    # обращение попадает в тот замер, которому не повезло быть первым, и разница
    # между страницами оказывается случайной — измерять надо установившийся режим.
    page(client, per_page=1)
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
    `test_ordered_roots_puts_the_name_first_and_id_last`.
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


def test_search_finds_a_merged_card_by_the_member_name(
    client: TestClient, db_session: Session
) -> None:
    """Б1: поиск по ФИО участника находит карточку присоединённой группы.

    У карточки без своего ФИО (`full_name = NULL`) показывается имя участника
    (`group_identities`). `_query_roots` отдавал `id` найденных строк, а `base`,
    `shifts` и `columns` держат корни, поэтому совпадение терялось на пересечении
    в `Candidates.roots()` и человек молча пропадал из выдачи.
    """
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    root = Employee(full_name=None, identity_status="confirmed")
    db_session.add(root)
    db_session.flush()
    member = Employee(full_name="Петров Олег", identity_status="confirmed", merged_into_id=root.id)
    db_session.add(member)
    db_session.flush()
    db_session.add(
        Resident(dormitory_id=dorm, employee_id=root.id, full_name=None, personnel_number="Т-1")
    )
    db_session.commit()
    found = page(client, query="петров")
    assert found["total"] == 1, found["items"]
    assert found["items"][0]["id"] == root.id
    # Карточка показывает имя участника, а не пустое ФИО строки-корня.
    assert found["items"][0]["full_name"] == "Петров Олег"


def test_nameless_card_sorts_under_the_placeholder_name(
    client: TestClient, db_session: Session
) -> None:
    """Б3: карточка без ФИО стоит под «ФИО не указано», как у клиента.

    `sort_name` строки-корня без ФИО пуст, поэтому SQL-порядок ставил такую
    карточку первой на странице, а клиентский `personName` показывает её как
    «ФИО не указано» и `filterPeople` кладёт под букву «ф».
    """
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    end = today() + timedelta(days=3)
    people = [
        Employee(id="aaa00000-0000-0000-0000-000000000001", full_name="Устинов Иван"),
        Employee(id="aaa00000-0000-0000-0000-000000000002", full_name=None),
        Employee(id="aaa00000-0000-0000-0000-000000000003", full_name="Хромов Пётр"),
    ]
    for employee in people:
        employee.identity_status = "confirmed"
    db_session.add_all(people)
    db_session.flush()
    db_session.add_all(
        Resident(
            dormitory_id=dorm,
            employee_id=employee.id,
            full_name=employee.full_name,
            shift_end=end,
        )
        for employee in people
    )
    db_session.commit()
    nameless = people[1]
    assert nameless.sort_name == ""
    items = page(client, per_page=50)["items"]
    assert [item["full_name"] for item in items] == ["Устинов Иван", None, "Хромов Пётр"]
    assert items[1]["id"] == nameless.id
    # При `ending` ключ — (конец вахты, показываемое имя, id); конец вахты один.
    ending = page(client, filter="ending", days=5, per_page=50)
    assert ending["total"] == 3
    assert [item["full_name"] for item in ending["items"]] == ["Устинов Иван", None, "Хромов Пётр"]


def test_phone_like_query_does_not_match_the_personnel_number(
    client: TestClient, db_session: Session
) -> None:
    """Б4: цифровая ветка поиска смотрит только телефоны, как клиент.

    Клиент (`matches`) и прежний порт искали цифры в телефоне и `variants.phone`,
    а не в склейке ФИО и табельного: телефоноподобный запрос не должен находить
    человека по цифрам табельного номера. Строки заведены в базе напрямую —
    проверяется чтение, а не запись карточки.
    """
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    kim = Employee(full_name="Ким Анна", personnel_number="Т-7912345")
    li = Employee(full_name="Ли Олег", personnel_number="Т-2", phone="+7 (912) 345-67-89")
    db_session.add_all([kim, li])
    db_session.flush()
    db_session.add_all(
        Resident(dormitory_id=dorm, employee_id=employee.id, full_name=employee.full_name)
        for employee in (kim, li)
    )
    db_session.commit()
    # Текстовая ветка табельный видит — как и раньше.
    assert [item["id"] for item in page(client, query="Т-7912345")["items"]] == [kim.id]
    assert [item["id"] for item in page(client, query="+7 912 345")["items"]] == [li.id]


def set_blocks(client: TestClient, kinds: list[str]) -> None:
    """Записать раскладку блоков поверхности через настройки."""
    frame = client.get(API, params={"employees": "none"}).json()
    blocks = [
        {
            "id": f"block{index}",
            "kind": kind,
            "title": f"Блок {index}",
            "scope": [],
            "days": 5,
            "limit": 4,
        }
        for index, kind in enumerate(kinds)
    ]
    response = client.put(
        API + "/preferences",
        json={"revision": frame["preferences"]["revision"], "blocks": blocks, "lists": []},
    )
    assert response.status_code == 200, response.text


def test_sql_count_does_not_grow_with_the_number_of_blocks(
    client: TestClient, db_session: Session
) -> None:
    """Б2: число запросов рамки не зависит от числа блоков (#251, шаг 3).

    Каждый блок звал `candidates()` заново: полный проход по строкам-источникам и
    журналу, вахты, порядок и полная сборка карточек. На раскладке по умолчанию
    `residents` и `contacts` дают одинаковые условия и считали одно и то же
    дважды, а цена рамки росла линейно от числа блоков. Отбор и карточки теперь
    общие, поэтому два и шесть блоков стоят одинаково.
    """
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    people = [
        Employee(full_name=f"Сотрудник {index:02d}", personnel_number=f"Т-{index:03d}")
        for index in range(6)
    ]
    db_session.add_all(people)
    db_session.flush()
    db_session.add_all(
        Resident(
            dormitory_id=dorm,
            employee_id=employee.id,
            full_name=employee.full_name,
            shift_end=today() + timedelta(days=index % 4),
        )
        for index, employee in enumerate(people)
    )
    db_session.commit()
    few_kinds = ["residents", "ending"]
    many_kinds = ["residents", "contacts", "ending", "residents", "ending", "ending"]
    bind = db_session.get_bind()
    statements: list[str] = []

    def before(*args: Any) -> None:
        statements.append("sql")

    def frame_cost(kinds: list[str]) -> tuple[int, int]:
        set_blocks(client, kinds)
        statements.clear()
        frame = client.get(API, params={"employees": "none"})
        assert frame.status_code == 200
        return len(statements), len(frame.json()["block_previews"])

    # Прогрев: первый запрос поднимает ленивые справочники процесса
    # (`table_import_jobs` читается один раз на процесс), и без прогрева это
    # обращение попадает в тот замер, которому не повезло быть первым. Греются
    # оба набора: мерить надо установившийся режим, а не порядок замеров.
    frame_cost(few_kinds)
    frame_cost(many_kinds)
    sa_event.listen(bind, "before_cursor_execute", before)
    try:
        few, few_blocks = frame_cost(few_kinds)
        many, many_blocks = frame_cost(many_kinds)
    finally:
        sa_event.remove(bind, "before_cursor_execute", before)
    assert (few_blocks, many_blocks) == (2, 6)
    assert few == many > 0


def test_blocks_keep_their_own_filter_over_the_shared_selection(
    client: TestClient, db_session: Session
) -> None:
    """Блок берёт свой фильтр, даже когда отбор с другим блоком общий (#251).

    Отбор в `SelectionCache` один на все блоки, и `Candidates` помнит фильтр
    того блока, который спросил первым. Пока набор блока пересекался с
    `found.roots()` без аргумента, «Заканчивается вахта» отдавал набор соседа:
    двое проживающих вместо одного, кто кончает вахту в окне. Раньше каждый блок
    считался своим `filtered(cards, criteria)`. Проверяются обе раскладки —
    сначала «Проживают», затем «Заканчивается вахта», — чтобы порядок блоков не
    решал, кто прав.
    """
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    near = Employee(full_name="Ближний Пётр", personnel_number="Т-901")
    far = Employee(full_name="Дальний Иван", personnel_number="Т-902")
    db_session.add_all([near, far])
    db_session.flush()
    db_session.add_all(
        [
            Resident(
                dormitory_id=dorm,
                employee_id=near.id,
                full_name=near.full_name,
                shift_end=today() + timedelta(days=3),
            ),
            Resident(
                dormitory_id=dorm,
                employee_id=far.id,
                full_name=far.full_name,
                shift_end=today() + timedelta(days=30),
            ),
        ]
    )
    db_session.commit()
    layouts = (
        (["residents", "ending"], 0, 1),
        (["ending", "residents"], 1, 0),
    )
    for kinds, residents_index, ending_index in layouts:
        set_blocks(client, kinds)
        frame = client.get(API, params={"employees": "none"}).json()
        previews = [BlockPreview.model_validate(item) for item in frame["block_previews"]]
        residents = previews[residents_index]
        ending = previews[ending_index]
        assert residents.count == len(residents.items) == 2, kinds
        assert ending.count == len(ending.items) == 1, kinds
        assert [item.full_name for item in ending.items] == ["Ближний Пётр"], kinds
        assert frame["counts"] == {"all": 2, "current": 2, "ending": 1}, kinds
