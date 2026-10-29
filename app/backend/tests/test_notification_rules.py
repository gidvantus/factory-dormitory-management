"""Конструктор правил уведомлений: каталог, проверка, срабатывание и текст.

Правило привязано к общежитию и таблице и срабатывает в момент записи строки.
Здесь проверяется всё, что составляет контракт с клиентом и с Telegram:

* каталог «таблица → столбцы → операторы» отдаёт только рабочие столбцы и
  верные для типа операторы;
* правило создаётся, срабатывает ровно один раз и молчит при правке постороннего
  столбца, пока значения условия не изменились;
* сообщение — это название правила, и тот же текст отдаёт предпросмотр;
* отказы 422/404/403 приходят дословными текстами контракта;
* архивный столбец делает правило «сломанным», но не удаляет его.

Тесты герметичны: SQLite в памяти, Telegram-чат подключается через домен, а не
через сеть.
"""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notifications, solutions
from app.models.organization import Organization
from app.models.solution import Solution
from app.models.telegram import NOTIFICATION_RULE_KIND, NotificationDelivery
from app.models.user import User
from app.solutions import SOLUTION_REQUIRED_DETAIL, TELEGRAM_NOTIFICATIONS
from app.telegram import render_message
from tests.conftest import add_colleague, give_solution, login, sign_in
from tests.test_custom_tabs import create_table, tab
from tests.test_reports import create_dormitory
from tests.test_resident_outflow import move as outflow_move
from tests.test_resident_outflow import preview as outflow_preview

# Операторы по типам столбцов: та же таблица, что в `app/notification_rules.py`.
EQUALITY_OPERATORS = {"equals", "not_equals", "not_empty", "is_empty"}
COMPARISON_OPERATORS = {*EQUALITY_OPERATORS, "greater", "less"}
CHECKBOX_OPERATORS = {"equals", "not_empty", "is_empty"}

CHAT_ID = "555"


def cabinet_user(
    client: TestClient,
    db_session: Session,
    *,
    email: str = "worker@example.com",
    with_solution: bool = True,
) -> User:
    """Войти пользователем кабинета: организация и (по умолчанию) право на решение.

    `sign_in` заводит организацию, но не выдаёт право; `with_solution=False`
    оставляет пользователя без него — для проверки 403 с текстом магазина.
    """
    user = sign_in(client, db_session, email=email)
    organization = db_session.get(Organization, user.active_organization_id)
    assert organization is not None
    if with_solution:
        give_solution(db_session, organization)
    return user


def grant_telegram_solution(db_session: Session, organization_id: int) -> None:
    """Выдать право на решение организации, у которой его ещё нет.

    `give_solution` завёл бы вторую строку каталога, а `solutions.code` и
    `name` уникальны: поэтому чужая организация получает право на **ту же**
    строку каталога, что уже заведена в базе.
    """
    solution = db_session.scalar(select(Solution).where(Solution.code == TELEGRAM_NOTIFICATIONS))
    assert solution is not None
    solutions.grant(db_session, organization_id, solution, invoice_id=None)
    db_session.commit()


def connect(db_session: Session, user: User, *, chat_id: str = CHAT_ID) -> None:
    """Подключить пользователю Telegram: тот же путь, что у ручки бота."""
    code, _ = notifications.issue_link_code(db_session, user)
    db_session.commit()
    assert notifications.link_chat(db_session, code=code, chat_id=chat_id, username="ivan")
    db_session.commit()


def rules_url(dorm: int) -> str:
    return f"/api/dormitories/{dorm}/telegram-rules"


def deliveries(db_session: Session) -> list[NotificationDelivery]:
    return list(db_session.scalars(select(NotificationDelivery).order_by(NotificationDelivery.id)))


def table_columns(client: TestClient, dorm: int, table_key: str) -> dict[str, dict[str, Any]]:
    """Столбцы таблицы по имени: через ручку столбцов, как это делает кабинет."""
    response = client.get(f"/api/dormitories/{dorm}/tables/{table_key}/columns")
    assert response.status_code == 200, response.text
    return {column["name"]: column for column in response.json()}


def catalog(client: TestClient, dorm: int) -> dict[str, dict[str, Any]]:
    response = client.get(rules_url(dorm) + "/catalog")
    assert response.status_code == 200, response.text
    return {table["key"]: table for table in response.json()["tables"]}


def create_rule(client: TestClient, dorm: int, **payload: Any) -> Any:
    return client.post(rules_url(dorm), json=payload)


def custom_table(client: TestClient, dorm: int) -> tuple[str, str, dict[str, dict[str, Any]]]:
    """Пользовательская вкладка с колонками всех типов, доступных условию.

    Возвращает путь к строкам, ключ таблицы (`custom_<id>`) и столбцы по имени.
    """
    item = tab(client, dorm)
    base, _table = create_table(client, dorm, item)
    return base, item["table_key"], table_columns(client, dorm, item["table_key"])


def edit_cell(
    client: TestClient,
    dorm: int,
    table_key: str,
    row_id: int,
    columns: dict[str, dict[str, Any]],
    name: str,
    value: Any,
) -> None:
    response = client.put(
        f"/api/dormitories/{dorm}/tables/{table_key}/rows/{row_id}/cells/{columns[name]['id']}",
        json={"value": value},
    )
    assert response.status_code == 200, response.text


# --- Каталог ------------------------------------------------------------------


def test_catalog_lists_working_columns_and_their_operators(
    client: TestClient, db_session: Session
) -> None:
    cabinet_user(client, db_session)
    dorm = create_dormitory(client)
    _base, table_key, columns = custom_table(client, dorm)
    assert set(columns) >= {"ФИО", "Дата", "Количество", "Отметка", "Статус"}

    tables = catalog(client, dorm)
    assert "residents" in tables
    residents = {column["name"]: column for column in tables["residents"]["columns"]}
    # Служебные кнопки и ссылка на место проживания условию недоступны.
    assert "ФИО" in residents
    assert "№" not in residents
    assert "Место проживания" not in residents
    assert set(residents["ФИО"]["operators"]) == EQUALITY_OPERATORS
    assert set(residents["Начало вахты"]["operators"]) == COMPARISON_OPERATORS
    assert set(residents["ЛМК"]["operators"]) == EQUALITY_OPERATORS

    by_name = {column["name"]: column for column in tables[table_key]["columns"]}
    assert by_name["Отметка"]["kind"] == "checkbox"
    assert set(by_name["Отметка"]["operators"]) == CHECKBOX_OPERATORS
    assert set(by_name["Количество"]["operators"]) == COMPARISON_OPERATORS


# --- Срабатывание, идемпотентность и текст сообщения ---------------------------


def test_rule_fires_once_and_the_message_is_exactly_its_name(
    client: TestClient, db_session: Session
) -> None:
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    base, table_key, columns = custom_table(client, dorm)

    response = create_rule(
        client,
        dorm,
        name="Документы готовы",
        table_key=table_key,
        conditions=[{"column_id": columns["ФИО"]["id"], "operator": "not_empty"}],
    )
    assert response.status_code == 201, response.text
    rule = response.json()
    assert rule["name"] == "Документы готовы"
    assert rule["broken"] is False
    assert rule["table_key"] == table_key

    row = client.post(base + "/rows").json()
    assert deliveries(db_session) == []

    edit_cell(client, dorm, table_key, row["id"], columns, "ФИО", "Иванов Иван")
    queued = deliveries(db_session)
    assert len(queued) == 1
    delivery = queued[0]
    assert delivery.user_id == user.id
    assert delivery.chat_id == CHAT_ID
    assert delivery.kind == NOTIFICATION_RULE_KIND
    assert delivery.rule_id == rule["id"]
    assert delivery.title == "Документы готовы"
    assert delivery.body == ""
    # Текст в Telegram — ровно название правила, без данных проживающих.
    assert render_message(delivery) == "Документы готовы"

    # Правка постороннего столбца при тех же значениях условия второй доставки
    # не создаёт: в ключ идемпотентности идут только столбцы условий.
    edit_cell(client, dorm, table_key, row["id"], columns, "Дата", "2026-10-09")
    assert len(deliveries(db_session)) == 1

    # Повторная правка столбца условия с тем же значением — тоже тишина.
    edit_cell(client, dorm, table_key, row["id"], columns, "ФИО", "Иванов Иван")
    assert len(deliveries(db_session)) == 1


def test_date_already_filled_does_not_resend_when_full_name_changes(
    client: TestClient, db_session: Session
) -> None:
    """Правка ФИО при уже заполненной дате второго сообщения не даёт.

    Сценарий из «готово, когда»: условие «дата в столбце не пуста», строка с
    датой, а меняется другой столбец. Значения условия не изменились — ключ
    идемпотентности тот же.
    """
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    resident = client.post(f"/api/dormitories/{dorm}/residents").json()["id"]
    table_key = "residents"
    columns = table_columns(client, dorm, table_key)

    response = create_rule(
        client,
        dorm,
        name="Вахта началась",
        table_key=table_key,
        conditions=[{"column_id": columns["Конец вахты"]["id"], "operator": "not_empty"}],
    )
    assert response.status_code == 201, response.text

    def patch(payload: dict[str, Any]) -> None:
        result = client.patch(
            f"/api/dormitories/{dorm}/residents/{resident}?month=2026-10-01", json=payload
        )
        assert result.status_code == 200, result.text

    patch({"shift_end": "2026-10-09"})
    queued = deliveries(db_session)
    assert [row.title for row in queued] == ["Вахта началась"]

    patch({"full_name": "Иванов Иван"})
    assert len(deliveries(db_session)) == 1


def test_new_row_after_condition_is_met_sends_once_per_row(
    client: TestClient, db_session: Session
) -> None:
    """Ключ идемпотентности содержит строку: вторая строка — второе сообщение."""
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    base, table_key, _columns = custom_table(client, dorm)
    assert (
        create_rule(
            client,
            dorm,
            name="Новая запись",
            table_key=table_key,
            conditions=[],
        ).status_code
        == 201
    )

    first = client.post(base + "/rows").json()
    second = client.post(base + "/rows").json()

    rows = deliveries(db_session)
    assert len(rows) == 2
    assert [row.event_key.split(":")[2] for row in rows] == [str(first["id"]), str(second["id"])]


def test_disabled_rule_is_silent(client: TestClient, db_session: Session) -> None:
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    base, table_key, _columns = custom_table(client, dorm)
    rule = create_rule(client, dorm, name="Стоп", table_key=table_key, conditions=[]).json()
    updated = client.put(
        f"{rules_url(dorm)}/{rule['id']}",
        json={"name": "Стоп", "table_key": table_key, "is_enabled": False, "conditions": []},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["is_enabled"] is False

    client.post(base + "/rows")

    assert deliveries(db_session) == []


# --- Сравнения по типам столбцов ----------------------------------------------


def test_number_comparison_uses_decimal_not_string_order(
    client: TestClient, db_session: Session
) -> None:
    """`"10" > "9"` строкой ложно: `greater` обязан сравнивать числа."""
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    base, table_key, columns = custom_table(client, dorm)
    assert (
        create_rule(
            client,
            dorm,
            name="Больше девяти",
            table_key=table_key,
            conditions=[
                {"column_id": columns["Количество"]["id"], "operator": "greater", "value": "9"}
            ],
        ).status_code
        == 201
    )

    row = client.post(base + "/rows").json()
    edit_cell(client, dorm, table_key, row["id"], columns, "Количество", "10")
    assert len(deliveries(db_session)) == 1

    other = client.post(base + "/rows").json()
    edit_cell(client, dorm, table_key, other["id"], columns, "Количество", "8")
    assert len(deliveries(db_session)) == 1


def test_checkbox_and_select_equals_compare_by_value(
    client: TestClient, db_session: Session
) -> None:
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    base, table_key, columns = custom_table(client, dorm)
    option_id = columns["Статус"]["options"][0]["id"]
    assert (
        create_rule(
            client,
            dorm,
            name="Готов и отмечен",
            table_key=table_key,
            conditions=[
                {"column_id": columns["Отметка"]["id"], "operator": "equals", "value": True},
                {
                    "column_id": columns["Статус"]["id"],
                    "operator": "not_equals",
                    "value": option_id,
                },
            ],
        ).status_code
        == 201
    )

    row = client.post(base + "/rows").json()
    edit_cell(client, dorm, table_key, row["id"], columns, "Отметка", True)
    edit_cell(client, dorm, table_key, row["id"], columns, "Статус", option_id)
    # `not_equals` на пустом статусе — не совпадение, поэтому доставки ещё нет.
    assert deliveries(db_session) == []

    edit_cell(
        client,
        dorm,
        table_key,
        row["id"],
        columns,
        "Статус",
        columns["Статус"]["options"][1]["id"],
    )
    assert len(deliveries(db_session)) == 1


# --- Предпросмотр -------------------------------------------------------------


def test_preview_returns_the_very_message_and_the_matching_rows_count(
    client: TestClient, db_session: Session
) -> None:
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    base, table_key, columns = custom_table(client, dorm)
    row = client.post(base + "/rows").json()

    empty = client.post(
        f"{rules_url(dorm)}/preview",
        json={
            "name": "Пусто",
            "table_key": table_key,
            "conditions": [{"column_id": columns["ФИО"]["id"], "operator": "not_empty"}],
        },
    )
    assert empty.status_code == 200, empty.text
    assert empty.json() == {"text": None, "matched": 0}

    edit_cell(client, dorm, table_key, row["id"], columns, "ФИО", "Иванов Иван")
    preview = client.post(
        f"{rules_url(dorm)}/preview",
        json={
            "name": "Иванов Иван",
            "table_key": table_key,
            "conditions": [{"column_id": columns["ФИО"]["id"], "operator": "not_empty"}],
        },
    )
    assert preview.status_code == 200, preview.text
    assert preview.json() == {"text": "Иванов Иван", "matched": 1}

    # Превью и доставка — один и тот же текст.
    assert (
        create_rule(
            client,
            dorm,
            name="Иванов Иван",
            table_key=table_key,
            conditions=[{"column_id": columns["ФИО"]["id"], "operator": "not_empty"}],
        ).status_code
        == 201
    )
    edit_cell(client, dorm, table_key, row["id"], columns, "ФИО", "Петров Пётр")
    assert render_message(deliveries(db_session)[0]) == preview.json()["text"]


# --- Сломанное правило и архивный столбец -------------------------------------


def test_archived_column_breaks_the_rule_and_cannot_join_a_new_one(
    client: TestClient, db_session: Session
) -> None:
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    _base, table_key, columns = custom_table(client, dorm)
    rule = create_rule(
        client,
        dorm,
        name="Есть примечание",
        table_key=table_key,
        conditions=[{"column_id": columns["ФИО"]["id"], "operator": "equals", "value": "Иванов"}],
    ).json()
    assert rule["broken"] is False

    column_id = columns["ФИО"]["id"]
    assert (
        client.delete(f"/api/dormitories/{dorm}/tables/{table_key}/columns/{column_id}").status_code
        == 204
    )

    listed = client.get(rules_url(dorm)).json()
    assert listed[0]["broken"] is True
    # Каталог архивный столбец не предлагает.
    by_name = {column["name"]: column for column in catalog(client, dorm)[table_key]["columns"]}
    assert "ФИО" not in by_name

    rejected = create_rule(
        client,
        dorm,
        name="Новое",
        table_key=table_key,
        conditions=[{"column_id": column_id, "operator": "not_empty"}],
    )
    assert rejected.status_code == 422
    assert rejected.json()["detail"] == "Столбец недоступен. Измените правило"

    # Удаление сломанного правила доступно всегда.
    assert client.delete(f"{rules_url(dorm)}/{rule['id']}").status_code == 204
    assert client.get(rules_url(dorm)).json() == []


# --- Отказы контракта ---------------------------------------------------------


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        (
            {"name": "   ", "table_key": "residents", "conditions": []},
            "Укажите название правила",
        ),
        (
            {"name": "Я" * 81, "table_key": "residents", "conditions": []},
            "Название правила — не длиннее 80 символов",
        ),
        (
            {
                "name": "Много",
                "table_key": "residents",
                "conditions": [
                    {"column_id": 1, "operator": "not_empty"},
                    {"column_id": 2, "operator": "not_empty"},
                    {"column_id": 3, "operator": "not_empty"},
                    {"column_id": 4, "operator": "not_empty"},
                    {"column_id": 5, "operator": "not_empty"},
                ],
            },
            "Выберите не больше 4 условий",
        ),
        (
            {"name": "Таблица", "table_key": "нет-такой", "conditions": []},
            "Столбец недоступен. Измените правило",
        ),
    ],
)
def test_rule_validation_texts_are_part_of_the_contract(
    client: TestClient, db_session: Session, payload: dict[str, Any], detail: str
) -> None:
    cabinet_user(client, db_session)
    dorm = create_dormitory(client)

    response = create_rule(client, dorm, **payload)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == detail


def test_condition_value_and_operator_are_validated(
    client: TestClient, db_session: Session
) -> None:
    cabinet_user(client, db_session)
    dorm = create_dormitory(client)
    columns = table_columns(client, dorm, "residents")

    without_value = create_rule(
        client,
        dorm,
        name="Без значения",
        table_key="residents",
        conditions=[{"column_id": columns["ФИО"]["id"], "operator": "equals"}],
    )
    assert without_value.status_code == 422
    assert without_value.json()["detail"] == "Укажите значение условия"

    wrong_operator = create_rule(
        client,
        dorm,
        name="Не тот оператор",
        table_key="residents",
        conditions=[{"column_id": columns["ФИО"]["id"], "operator": "greater", "value": "А"}],
    )
    assert wrong_operator.status_code == 422
    assert wrong_operator.json()["detail"] == "Этот оператор не подходит для столбца"

    unknown_column = create_rule(
        client,
        dorm,
        name="Чужой столбец",
        table_key="residents",
        conditions=[{"column_id": 999999, "operator": "not_empty"}],
    )
    assert unknown_column.status_code == 422
    assert unknown_column.json()["detail"] == "Столбец недоступен. Измените правило"


# --- Доступ -------------------------------------------------------------------


def test_without_the_solution_the_handlers_answer_403_with_the_store_text(
    client: TestClient, db_session: Session
) -> None:
    cabinet_user(client, db_session, with_solution=False)
    dorm = create_dormitory(client)

    listed = client.get(rules_url(dorm))
    assert listed.status_code == 403
    assert listed.json()["detail"] == SOLUTION_REQUIRED_DETAIL
    assert create_rule(client, dorm, name="Нельзя", table_key="residents").status_code == 403


def test_rule_of_another_person_and_another_dormitory_is_404(
    client: TestClient, db_session: Session
) -> None:
    owner = cabinet_user(client, db_session)
    organization = db_session.get(Organization, owner.active_organization_id)
    assert organization is not None
    colleague = add_colleague(db_session, organization.id)
    dorm = create_dormitory(client)
    rule = create_rule(client, dorm, name="Личное", table_key="residents").json()

    # Коллега по организации чужих правил не видит и править их не может.
    assert login(client, colleague.email).status_code == 200
    assert client.get(rules_url(dorm)).json() == []
    assert (
        client.put(
            f"{rules_url(dorm)}/{rule['id']}",
            json={"name": "Чужое", "table_key": "residents", "conditions": []},
        ).status_code
        == 404
    )
    assert client.delete(f"{rules_url(dorm)}/{rule['id']}").status_code == 404

    # Чужое общежитие — 404 «Общежитие не найдено», как у несуществующего.
    outsider = sign_in(client, db_session, email="outsider@example.com")
    outsider_org = db_session.get(Organization, outsider.active_organization_id)
    assert outsider_org is not None
    # Право чужой организации на ту же строку каталога: без него ответ был бы 403.
    grant_telegram_solution(db_session, outsider_org.id)
    foreign = client.get(rules_url(dorm))
    assert foreign.status_code == 404
    assert foreign.json()["detail"] == "Общежитие не найдено"


def test_missing_rule_is_404(client: TestClient, db_session: Session) -> None:
    cabinet_user(client, db_session)
    dorm = create_dormitory(client)

    missing = client.delete(f"{rules_url(dorm)}/999999")

    assert missing.status_code == 404
    assert missing.json()["detail"] == "Правило не найдено"


def test_delivery_is_not_created_without_a_connected_chat(
    client: TestClient, db_session: Session
) -> None:
    """Правило есть, условий достаточно, но чат не подключён — доставлять некуда."""
    cabinet_user(client, db_session)
    dorm = create_dormitory(client)
    base, table_key, _columns = custom_table(client, dorm)
    assert create_rule(client, dorm, name="Некуда", table_key=table_key).status_code == 201

    client.post(base + "/rows")

    assert deliveries(db_session) == []


# --- Проводка хуков по точкам записи -----------------------------------------
#
# Каждый путь записи обязан ставить правила своей таблицы. Регрессия здесь
# невидима иначе: правило в списке включено и не сломано, а сообщения нет.


def test_rule_on_outflow_fires_when_the_row_is_created(
    client: TestClient, db_session: Session
) -> None:
    """Строка «Оттока», добавленная кнопкой «+», — событие правила этой таблицы."""
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    rule = create_rule(client, dorm, name="Новая строка оттока", table_key="outflow").json()

    assert client.post(f"/api/dormitories/{dorm}/outflow").status_code == 201

    assert [row.title for row in deliveries(db_session)] == [rule["name"]]


def test_rule_on_outflow_fires_on_move_from_residents(
    client: TestClient, db_session: Session
) -> None:
    """Кнопка «В отток» тоже пишет строку «Оттока» — правило срабатывает."""
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    resident = client.post(f"/api/dormitories/{dorm}/residents").json()["id"]
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/residents/{resident}?month=2026-10-01",
            json={"full_name": "Иванов Иван"},
        ).status_code
        == 200
    )
    assert create_rule(client, dorm, name="Ушёл в отток", table_key="outflow").status_code == 201

    plan = outflow_preview(client, dorm, resident)
    assert outflow_move(client, dorm, resident, plan).status_code == 201

    assert [row.title for row in deliveries(db_session)] == ["Ушёл в отток"]


def test_rule_on_residents_fires_on_row_creation_and_on_patch(
    client: TestClient, db_session: Session
) -> None:
    """«Добавить строку» и сохранение полей — два разных пути записи."""
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    columns = table_columns(client, dorm, "residents")
    assert create_rule(client, dorm, name="Добавление", table_key="residents").status_code == 201
    assert (
        create_rule(
            client,
            dorm,
            name="ФИО заполнено",
            table_key="residents",
            conditions=[{"column_id": columns["ФИО"]["id"], "operator": "not_empty"}],
        ).status_code
        == 201
    )

    resident = client.post(f"/api/dormitories/{dorm}/residents").json()["id"]
    assert [row.title for row in deliveries(db_session)] == ["Добавление"]

    assert (
        client.patch(
            f"/api/dormitories/{dorm}/residents/{resident}?month=2026-10-01",
            json={"full_name": "Иванов Иван"},
        ).status_code
        == 200
    )
    assert [row.title for row in deliveries(db_session)] == ["Добавление", "ФИО заполнено"]


def test_rule_on_advance_fires_on_row_creation_and_on_patch(
    client: TestClient, db_session: Session
) -> None:
    """«На аванс» пишется и кнопкой «+», и правкой строки — оба пути под правилом."""
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    columns = table_columns(client, dorm, "advance")
    assert create_rule(client, dorm, name="Новая выплата", table_key="advance").status_code == 201
    assert (
        create_rule(
            client,
            dorm,
            name="Аванс больше девяти",
            table_key="advance",
            conditions=[
                {
                    "column_id": columns["Сумма аванса"]["id"],
                    "operator": "greater",
                    "value": "9",
                }
            ],
        ).status_code
        == 201
    )

    row = client.post(f"/api/dormitories/{dorm}/payments/advance").json()
    assert [item.title for item in deliveries(db_session)] == ["Новая выплата"]

    assert (
        client.patch(
            f"/api/dormitories/{dorm}/payments/advance/{row['id']}",
            json={"advance_amount": "10"},
        ).status_code
        == 200
    )
    assert [item.title for item in deliveries(db_session)] == [
        "Новая выплата",
        "Аванс больше девяти",
    ]


def test_rule_on_advance_fires_when_a_resident_is_registered_for_payment(
    client: TestClient, db_session: Session
) -> None:
    """Запись проживающего на аванс создаёт строку «На аванс» — это событие."""
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    resident = client.post(f"/api/dormitories/{dorm}/residents").json()["id"]
    assert (
        client.patch(
            f"/api/dormitories/{dorm}/residents/{resident}?month=2026-10-01",
            json={"full_name": "Иванов Иван", "personnel_number": "123"},
        ).status_code
        == 200
    )
    assert (
        create_rule(client, dorm, name="Выписан на аванс", table_key="advance").status_code == 201
    )

    response = client.post(f"/api/dormitories/{dorm}/residents/{resident}/payments/advance")

    assert response.status_code == 201, response.text
    assert [row.title for row in deliveries(db_session)] == ["Выписан на аванс"]


def test_rule_on_archive_fires_when_the_row_is_created(
    client: TestClient, db_session: Session
) -> None:
    """«Архив» есть в каталоге — значит, и его пути записи обязаны ставить правила."""
    user = cabinet_user(client, db_session)
    connect(db_session, user)
    dorm = create_dormitory(client)
    assert create_rule(client, dorm, name="Запись в архив", table_key="archive").status_code == 201

    assert client.post(f"/api/dormitories/{dorm}/tables/archive/rows").status_code == 201

    assert [row.title for row in deliveries(db_session)] == ["Запись в архив"]


# --- Заголовок удалённой таблицы ----------------------------------------------


def test_deleted_tab_is_named_in_the_broken_rule(client: TestClient, db_session: Session) -> None:
    """Удалённая вкладка: технический ключ `custom_7` человеку ничего не говорит."""
    cabinet_user(client, db_session)
    dorm = create_dormitory(client)
    item = tab(client, dorm)
    create_table(client, dorm, item)
    table_key = item["table_key"]
    assert create_rule(client, dorm, name="Сломалось", table_key=table_key).status_code == 201
    assert client.delete(f"/api/dormitories/{dorm}/tabs/{item['id']}").status_code == 204

    listed = client.get(rules_url(dorm)).json()

    assert listed[0]["broken"] is True
    assert listed[0]["table_title"] == "Таблица удалена"
    assert listed[0]["table_key"] == table_key


def test_deleted_section_keeps_its_human_name(client: TestClient, db_session: Session) -> None:
    """Раздел восстановим, поэтому имя берётся из каталога разделов, а не из ключа."""
    cabinet_user(client, db_session)
    dorm = create_dormitory(client)
    assert create_rule(client, dorm, name="Архивная запись", table_key="archive").status_code == 201
    assert client.delete(f"/api/dormitories/{dorm}/sections/archive").status_code == 200

    listed = client.get(rules_url(dorm)).json()

    assert listed[0]["broken"] is True
    assert listed[0]["table_title"] == "Архив"
