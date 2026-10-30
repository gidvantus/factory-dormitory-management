"""Правила уведомлений по общежитиям: каталог, проверка, оценка и очередь.

Правило привязывается к общежитию и таблице и срабатывает в момент записи
строки, когда выполнены условия по её столбцам. Это персональная настройка: у
каждого пользователя свои правила, и доставка адресована только владельцу
правила. Существующее уведомление о выселении (`app/notifications.py`) живёт
отдельно и своим правилом не становится.

**Сообщение — это название правила.** Поля сообщения и подстановки данных
проживающих здесь нет и быть не должно: `title` доставки равен `name` правила,
`body` пустая строка, а `app/telegram.py::render_message` на пустом теле
возвращает только тему. Никаких ФИО, табельных номеров, дат, сумм и названий
общежития в текст не попадает.

**Идемпотентность без таблицы состояний.** Ключ доставки —
`rule:<id>:<строка>:<sha1(условия + значения этих столбцов)[:16]>`. Уникальность
`(user_id, event_key)` держит база, поэтому правка постороннего столбца при
неизменных значениях условия второго сообщения не даёт, а повторный вызов хука
по тому же событию упирается в уже стоящую доставку.

Модуль, как и `app/notifications.py`, не знает про FastAPI-роуты: он отдаёт
готовые строки `notification_deliveries` и умеет отвечать на вопросы «каталог»,
«правило сломано», «подходит ли строка». HTTP-слой живёт в
`app/api/notification_rules.py`.
"""

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.payment import PaymentEntry
from app.models.table_column import TableColumn
from app.models.telegram import (
    DELIVERY_PENDING,
    NOTIFICATION_RULE_KIND,
    NotificationDelivery,
    NotificationRule,
    TelegramLink,
)
from app.models.user import User
from app.section_state import SECTIONS, section_ancestors, section_status
from app.solutions import TELEGRAM_NOTIFICATIONS, has_solution
from app.table_data import (
    DEFAULT_COLUMNS,
    TABLE_MODELS,
    Record,
    columns_for,
    ensure_columns,
    normalize_value,
    record_value,
    records_for,
)

logger = logging.getLogger(__name__)

# Потолок условий: правило срабатывает, когда верны все условия сразу, и больше
# четырёх условий человек уже не читает в списке.
MAX_CONDITIONS = 4

# Длина названия правила. Это же название уходит в Telegram, и разметки там нет:
# символы `*`, `_`, `<` из названия остаются как есть.
MAX_NAME_LENGTH = 80

# Операторы и типы столбцов, к которым они применимы. Список — часть контракта:
# каталог отдаёт его клиенту, чтобы селектор операторов не строился на клиенте.
EQUALITY_OPERATORS = ("equals", "not_equals", "not_empty", "is_empty")
COMPARISON_OPERATORS = (*EQUALITY_OPERATORS, "greater", "less")
OPERATORS_BY_KIND: dict[str, tuple[str, ...]] = {
    "text": EQUALITY_OPERATORS,
    "select": EQUALITY_OPERATORS,
    "number": COMPARISON_OPERATORS,
    "date": COMPARISON_OPERATORS,
    "checkbox": ("equals", "not_empty", "is_empty"),
}

# Столбцы, по которым условия разрешены. `action` и `hostel` — служебные кнопки и
# ссылка на место проживания; по ним условие не имеет смысла, и в каталог они не
# попадают — как и в каталог блоков дашборда.
RULE_COLUMN_KINDS = tuple(OPERATORS_BY_KIND)

NO_VALUE_OPERATORS = ("not_empty", "is_empty")

# Тексты отказов — часть контракта с клиентом: фронт показывает `detail`
# дословно и не переписывает. Поэтому проверки живут здесь, а не в схеме
# Pydantic: у схемы `detail` — список ошибок, а человеку нужна одна строка.
NAME_REQUIRED_DETAIL = "Укажите название правила"
NAME_TOO_LONG_DETAIL = "Название правила — не длиннее 80 символов"
TOO_MANY_CONDITIONS_DETAIL = "Выберите не больше 4 условий"
VALUE_REQUIRED_DETAIL = "Укажите значение условия"
COLUMN_UNAVAILABLE_DETAIL = "Столбец недоступен. Измените правило"
OPERATOR_MISMATCH_DETAIL = "Этот оператор не подходит для столбца"
RULE_NOT_FOUND_DETAIL = "Правило не найдено"


DELETED_TABLE_TITLE = "Таблица удалена"


@dataclass(frozen=True)
class RuleCondition:
    """Условие правила в том виде, в каком оно хранится в JSON.

    `value` приведён к типу столбца (`normalize_value`): число — канонической
    строкой, дата — ISO-строкой, чекбокс — `bool`. У «заполнено/не заполнено»
    значения нет.
    """

    column_id: int
    operator: str
    value: str | bool | None = None


@dataclass(frozen=True)
class CatalogColumn:
    """Столбец, доступный условию правила, и операторы, которые к нему подходят."""

    id: int
    name: str
    kind: str
    operators: tuple[str, ...]


@dataclass(frozen=True)
class CatalogTable:
    """Таблица общежития в каталоге конструктора."""

    key: str
    title: str
    columns: list[CatalogColumn]


def _tab_id(table_key: str) -> int | None:
    """Номер пользовательской вкладки из ключа таблицы. `None` — ключ не наш."""
    if not table_key.startswith("custom_"):
        return None
    try:
        return int(table_key.removeprefix("custom_"))
    except ValueError:
        return None


def _section_exists(dormitory: Dormitory, key: str) -> bool:
    """Раздел не удалён: удалённый не может принимать правила."""
    return not any(
        section_status(dormitory, item) == "deleted" for item in section_ancestors(dormitory, key)
    )


def _section_title(dormitory: Dormitory, key: str) -> str:
    """Заголовок раздела с цепочкой родителей: так его читает кабинет."""
    chain = section_ancestors(dormitory, key)
    title = " / ".join(SECTIONS[item] for item in reversed(chain))
    if any(section_status(dormitory, item) == "hidden" for item in chain):
        title += " (скрыта)"
    return title


def _custom_tab(db: Session, dormitory_id: int, tab_id: int) -> CustomTab | None:
    """Живая пользовательская вкладка этого общежития, если она есть."""
    tab = db.get(CustomTab, tab_id)
    if tab is None or tab.dormitory_id != dormitory_id or tab.is_group or not tab.table_created:
        return None
    return tab


def tabs_index(db: Session, dormitory: Dormitory) -> dict[int, CustomTab]:
    """Все вкладки общежития одним запросом, по номеру.

    Список правил и каталог передают этот словарь в `_custom_title`: иначе
    каждое правило с пользовательской вкладкой тянуло бы все вкладки общежития
    отдельным запросом (N правил — N одинаковых запросов).
    """
    tabs = db.scalars(
        select(CustomTab).where(CustomTab.dormitory_id == dormitory.id).order_by(CustomTab.id)
    )
    return {tab.id: tab for tab in tabs}


def _custom_title(
    db: Session,
    dormitory: Dormitory,
    tab: CustomTab,
    *,
    tabs_by_id: dict[int, CustomTab] | None = None,
) -> str:
    """Заголовок пользовательской таблицы цепочкой вкладок, как в дашборде.

    `tabs_by_id` — уже прочитанные вкладки общежития (`tabs_index`); без него
    читаются здесь, и это годится только для ответа про одно правило.
    """
    by_id = tabs_by_id if tabs_by_id is not None else tabs_index(db, dormitory)
    chain = [tab]
    while chain[0].parent_id in by_id:
        chain.insert(0, by_id[chain[0].parent_id])
    parent = chain[0].parent_section
    title = (_section_title(dormitory, parent) + " / " if parent else "") + " / ".join(
        item.name for item in chain
    )
    if any(not item.is_active for item in chain):
        title += " (скрыта)"
    return title


def _available_columns(columns: list[TableColumn]) -> list[TableColumn]:
    """Столбцы, которые могут входить в условие: не архивные и нужного вида."""
    return [
        column for column in columns if not column.archived and column.kind in RULE_COLUMN_KINDS
    ]


def table_title(
    db: Session,
    dormitory: Dormitory,
    table_key: str,
    *,
    tabs_by_id: dict[int, CustomTab] | None = None,
) -> str:
    """Заголовок таблицы для ответа: по нему человек узнаёт, что восстанавливать.

    Удалённая таблица оставляет правило в списке «сломанным», и ответ обязан
    назвать её по-человечески: технический ключ (`custom_7`, `residents`) в
    строке списка ничего не значит. У удалённого раздела имя остаётся в
    `SECTIONS` — раздел восстановим, поэтому имя берётся оттуда; у удалённой
    вкладки имени не осталось, и ответ говорит прямо «Таблица удалена».
    Совсем незнакомый ключ (правило, записанное другой версией) отдаётся как есть.

    `tabs_by_id` — общий для всего ответа список вкладок: список правил читает
    его один раз, а не по разу на строку.
    """
    if table_key in DEFAULT_COLUMNS:
        if _section_exists(dormitory, table_key):
            return _section_title(dormitory, table_key)
        return SECTIONS[table_key]
    tab_id = _tab_id(table_key)
    tab = _custom_tab(db, dormitory.id, tab_id) if tab_id is not None else None
    if tab is not None:
        return _custom_title(db, dormitory, tab, tabs_by_id=tabs_by_id)
    return DELETED_TABLE_TITLE if tab_id is not None else table_key


def catalog(db: Session, dormitory: Dormitory) -> list[CatalogTable]:
    """Каталог «таблица → столбцы» для конструктора правил.

    Один список на два вопроса клиента: что можно выбрать в правиле и какие
    операторы подходят к столбцу. Архивные столбцы, служебные кнопки (`action`)
    и ссылка на место проживания (`hostel`) в каталог не попадают.

    Заголовки собираются тем же правилом, что и в каталоге блоков дашборда
    (`app/dashboard_blocks.py::source_catalog`): раздел с родителями, «(скрыта)»
    у скрытой вкладки и ` / ` между уровнями.
    """
    tables: list[CatalogTable] = []
    for key in DEFAULT_COLUMNS:
        if not _section_exists(dormitory, key):
            continue
        columns = _available_columns(ensure_columns(db, dormitory.id, key))
        tables.append(
            CatalogTable(
                key=key, title=_section_title(dormitory, key), columns=_catalog_columns(columns)
            )
        )
    tabs = list(
        db.scalars(
            select(CustomTab).where(CustomTab.dormitory_id == dormitory.id).order_by(CustomTab.id)
        )
    )
    by_id = {tab.id: tab for tab in tabs}
    for tab in tabs:
        if not tab.table_created or tab.is_group:
            continue
        columns = _available_columns(ensure_columns(db, dormitory.id, tab.table_key))
        tables.append(
            CatalogTable(
                key=tab.table_key,
                title=_custom_title(db, dormitory, tab, tabs_by_id=by_id),
                columns=_catalog_columns(columns),
            )
        )
    return tables


def _catalog_columns(columns: list[TableColumn]) -> list[CatalogColumn]:
    return [
        CatalogColumn(
            id=column.id,
            name=column.name,
            kind=column.kind,
            operators=OPERATORS_BY_KIND[column.kind],
        )
        for column in columns
    ]


def _table_columns(
    db: Session, dormitory_id: int, table_key: str, *, create_missing: bool
) -> list[TableColumn] | None:
    """Столбцы таблицы правила. `None` — такой таблицы у общежития нет.

    Одна функция на два вопроса: «можно ли сохранить правило» (`create_missing=
    True` — у встроенной таблицы недостающие столбцы заводятся тем же путём, что
    и в каталоге, чтобы правило не зависело от того, открывали ли до него
    конструктор) и «работает ли уже сохранённое правило» (`False` — только
    чтение, чтобы список правил не писал в базу). Ветки проверок у обоих
    вопросов обязаны совпадать, поэтому они живут здесь, а не в двух копиях.

    У пользовательской вкладки столбцы только читаются в обоих случаях: их
    набор задаёт человек, и создавать там нечего.
    """
    if table_key.startswith("custom_"):
        tab_id = _tab_id(table_key)
        if tab_id is None or _custom_tab(db, dormitory_id, tab_id) is None:
            return None
        return _available_columns(columns_for(db, dormitory_id, table_key))
    if table_key not in DEFAULT_COLUMNS:
        return None
    dormitory = db.get(Dormitory, dormitory_id)
    if dormitory is None or not _section_exists(dormitory, table_key):
        return None
    if create_missing:
        return _available_columns(ensure_columns(db, dormitory_id, table_key))
    return _available_columns(columns_for(db, dormitory_id, table_key))


def _clean_name(name: str) -> str:
    """Название без крайних пробелов. Внутренний текст не переписывается."""
    return name.strip()


def _normalize_condition(column: TableColumn, operator: str, value: Any) -> RuleCondition:
    """Проверить условие и привести значение к типу столбца."""
    if operator in NO_VALUE_OPERATORS:
        return RuleCondition(column_id=column.id, operator=operator, value=None)
    if value is None or (isinstance(value, str) and not value.strip()):
        raise HTTPException(422, VALUE_REQUIRED_DETAIL)
    normalized = normalize_value(column, value, allow_archived=True)
    if normalized is None:
        raise HTTPException(422, VALUE_REQUIRED_DETAIL)
    return RuleCondition(column_id=column.id, operator=operator, value=normalized)


def validate_condition(
    columns: dict[int, TableColumn], condition: RuleCondition | dict[str, Any]
) -> RuleCondition:
    """Проверить одно условие против столбцов таблицы.

    Telegram-разметки, подстановок и полей сообщения здесь нет вовсе: условие —
    это пара «столбец, оператор» и значение.
    """
    if isinstance(condition, dict):
        try:
            column_id = int(str(condition.get("column_id")))
            operator = str(condition.get("operator", ""))
        except (TypeError, ValueError) as error:
            raise HTTPException(422, COLUMN_UNAVAILABLE_DETAIL) from error
        value = condition.get("value")
    else:
        column_id, operator, value = condition.column_id, condition.operator, condition.value
    column = columns.get(column_id)
    if column is None:
        raise HTTPException(422, COLUMN_UNAVAILABLE_DETAIL)
    if operator not in OPERATORS_BY_KIND.get(column.kind, ()):
        raise HTTPException(422, OPERATOR_MISMATCH_DETAIL)
    return _normalize_condition(column, operator, value)


def validate_rule(
    db: Session,
    dormitory_id: int,
    *,
    name: str,
    table_key: str,
    conditions: list[RuleCondition] | list[dict[str, Any]],
) -> tuple[str, list[RuleCondition]]:
    """Проверить правило целиком. Возвращает очищенное название и условия.

    Порядок проверок — как в текстах контракта: сначала название, потом потолок
    условий, потом столбцы. Отказы 422, потому что по ним человек правит
    правило, а не потому что тело не разбирается.
    """
    cleaned = _clean_name(name)
    if not cleaned:
        raise HTTPException(422, NAME_REQUIRED_DETAIL)
    if len(cleaned) > MAX_NAME_LENGTH:
        raise HTTPException(422, NAME_TOO_LONG_DETAIL)
    if len(conditions) > MAX_CONDITIONS:
        raise HTTPException(422, TOO_MANY_CONDITIONS_DETAIL)
    columns = _table_columns(db, dormitory_id, table_key, create_missing=True)
    if columns is None:
        raise HTTPException(422, COLUMN_UNAVAILABLE_DETAIL)
    by_id = {column.id: column for column in columns}
    return cleaned, [validate_condition(by_id, condition) for condition in conditions]


def stored_conditions(rule: NotificationRule) -> list[RuleCondition]:
    """Условия правила из JSON. Строки неизвестной формы пропускаются.

    Проверку формы держит `validate_rule`, но правило могло быть записано раньше
    или столкнуться с правкой схемы. Оценка обязана пережить такую строку, а не
    упасть на каждой записи в таблице.
    """
    result: list[RuleCondition] = []
    for item in rule.conditions or []:
        if not isinstance(item, dict):
            continue
        try:
            column_id = int(item["column_id"])
            operator = str(item["operator"])
        except (KeyError, TypeError, ValueError):
            continue
        result.append(
            RuleCondition(column_id=column_id, operator=operator, value=item.get("value"))
        )
    return result


def _usable(column: TableColumn | None, condition: RuleCondition) -> bool:
    """Годится ли столбец для условия: он есть, не архивный и оператор подходит.

    Архивность проверяется здесь ещё раз, хотя набор столбцов уже приходит из
    `_available_columns`: раньше ответ на вопрос «работает ли правило» давали две
    копии проверки — список правил фильтровал архивные столбцы, а оценка события
    брала все, — и правило с удалённым столбцом продолжало присылать сообщения.
    Теперь оба пути идут через `_table_columns`, а эта проверка держит инвариант
    «сломанное правило молчит» на уровне самого признака сломанности.
    """
    return (
        column is not None
        and not column.archived
        and condition.operator in OPERATORS_BY_KIND.get(column.kind, ())
    )


def is_broken(db: Session, dormitory_id: int, rule: NotificationRule) -> bool:
    """Правило не работает: таблицы нет или столбец удалён/архивирован.

    Отдельный ответ списка (`broken`): правило не удаляется само и удаление
    остаётся доступным всегда, а оценка такое правило просто пропускает.
    """
    conditions = stored_conditions(rule)
    columns = _table_columns(db, dormitory_id, rule.table_key, create_missing=False)
    if columns is None:
        return True
    by_id = {column.id: column for column in columns}
    return any(not _usable(by_id.get(condition.column_id), condition) for condition in conditions)


def _filled(value: Any) -> bool:
    """Заполнено ли значение: `None`, пустая строка и пробелы — не заполнено."""
    if value is None:
        return False
    return not (isinstance(value, str) and not value.strip())


def _as_decimal(value: Any) -> Decimal | None:
    """Число из значения столбца. `None` — не число."""
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() else None


def _as_date(value: Any) -> date | None:
    """Дата из ISO-значения. `None` — не дата."""
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def _equal(column: TableColumn, actual: Any, expected: Any) -> bool:
    """Совпадает ли значение столбца с ожидаемым — с учётом типа столбца.

    Числа сравниваются `Decimal`, а не строкой: `normalize_value` хранит их
    канонической записью, и `"10" > "9"` строкой дало бы неверный результат.
    """
    if column.kind == "number":
        left, right = _as_decimal(actual), _as_decimal(expected)
        return left is not None and right is not None and left == right
    if column.kind == "checkbox":
        return bool(actual) == bool(expected)
    return str(actual) == str(expected)


def _greater(column: TableColumn, actual: Any, expected: Any) -> bool:
    """Сравнение «больше» для чисел и дат. Остальные типы так не сравниваются."""
    if column.kind == "number":
        left, right = _as_decimal(actual), _as_decimal(expected)
        return left is not None and right is not None and left > right
    if column.kind == "date":
        first, second = _as_date(actual), _as_date(expected)
        return first is not None and second is not None and first > second
    return False


def matches(column: TableColumn, condition: RuleCondition, actual: Any) -> bool:
    """Выполнено ли одно условие на значении столбца этой строки.

    У чекбокса «пусто» — это снятая галка, а не отсутствие значения:
    `record_value` отдаёт для незаполненного чекбокса `False`, поэтому `_filled`
    считал бы его заполненным и `is_empty` не выполнялся бы никогда, а
    `not_empty` — всегда. Каталог предлагает чекбоксу оба оператора, поэтому
    смысл у них ровно один: галка стоит или её нет.
    """
    if column.kind == "checkbox" and condition.operator in NO_VALUE_OPERATORS:
        return bool(actual) == (condition.operator == "not_empty")
    if condition.operator == "not_empty":
        return _filled(actual)
    if condition.operator == "is_empty":
        return not _filled(actual)
    if condition.operator == "equals":
        return _filled(actual) and _equal(column, actual, condition.value)
    if condition.operator == "not_equals":
        # Пустая ячейка условию «не равно» не соответствует — как `NULL <> x` в
        # SQL. Иначе правка постороннего столбца в строке с незаполненным
        # условием присылала бы сообщение.
        return _filled(actual) and not _equal(column, actual, condition.value)
    if not _filled(actual):
        return False
    if condition.operator == "greater":
        return _greater(column, actual, condition.value)
    if condition.operator == "less":
        return _greater(column, condition.value, actual)
    return False


def row_matches(
    row: Record, conditions: list[RuleCondition], columns: dict[int, TableColumn]
) -> bool:
    """Конъюнкция условий правила на строке. Пустой список — «любая запись»."""
    for condition in conditions:
        column = columns.get(condition.column_id)
        if column is None or not matches(column, condition, record_value(row, column)):
            return False
    return True


def _load_row(db: Session, dormitory_id: int, table_key: str, row_id: int) -> Record | None:
    """Перечитать строку после коммита: у ORM-объекта из ручки состояние уже устарело."""
    if table_key.startswith("custom_"):
        tab_id = _tab_id(table_key)
        if tab_id is None:
            return None
        return db.scalar(
            select(CustomTabEntry).where(
                CustomTabEntry.id == row_id,
                CustomTabEntry.dormitory_id == dormitory_id,
                CustomTabEntry.tab_id == tab_id,
            )
        )
    model = TABLE_MODELS.get(table_key)
    if model is None:
        return None
    query = select(model).where(model.id == row_id, model.dormitory_id == dormitory_id)
    if table_key in ("advance", "settlement"):
        query = query.where(PaymentEntry.kind == table_key)
    return cast(Record | None, db.scalar(query))


def event_key(rule_id: int, row_id: int, conditions: list[RuleCondition], values: list[Any]) -> str:
    """Ключ идемпотентности доставки: правило, строка и значения условий.

    В хеш идут только значения столбцов из условий, а не все столбцы строки:
    иначе правка постороннего столбца создавала бы второе сообщение. Хеш
    усечён до 16 символов — этого хватает на различение событий, а колонка
    `event_key` короткая (`varchar(80)`).
    """
    payload = json.dumps(
        [
            [
                {"column_id": item.column_id, "operator": item.operator, "value": item.value}
                for item in conditions
            ],
            values,
        ],
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    digest = hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]
    return f"rule:{rule_id}:{row_id}:{digest}"


def queue_rule_events(
    db: Session, *, dormitory_id: int, table_key: str, row_id: int, actor_id: int
) -> int:
    """Поставить доставки по сработавшим правилам. Возвращает число новых.

    Перебираются включённые правила этого общежития и этой таблицы. Строка
    перечитывается после коммита записи, поэтому оценка идёт по сохранённым
    значениям, а не по тому, что было до правки.

    Получатель — владелец правила, а не автор записи: правило персональное, и
    `actor_id` здесь только для журнала и симметрии с `queue_resident_outflow`.
    Доставка не ставится, если у владельца нет живого чата.

    Право организации на `telegram_notifications` проверяется один раз на
    событие — как у выселения: с истёкшей подпиской правило молчит, хотя строки
    `telegram_links` и `notification_rules` остаются.

    Коммитит сама: уведомление не часть транзакции записи, и падение рассылки не
    должно откатывать уже подтверждённую строку.
    """
    rules = list(
        db.scalars(
            select(NotificationRule)
            .where(
                NotificationRule.dormitory_id == dormitory_id,
                NotificationRule.table_key == table_key,
                NotificationRule.is_enabled.is_(True),
            )
            .order_by(NotificationRule.id)
        )
    )
    if not rules:
        return 0

    dormitory = db.get(Dormitory, dormitory_id)
    if dormitory is None or not has_solution(db, dormitory.organization_id, TELEGRAM_NOTIFICATIONS):
        return 0

    row = _load_row(db, dormitory_id, table_key, row_id)
    if row is None:
        return 0

    # Тот же набор столбцов, что у списка правил (`is_broken`): архивные и
    # удалённые в условия не входят, и правило с таким столбцом молчит.
    available = _table_columns(db, dormitory_id, table_key, create_missing=False)
    if available is None:
        return 0
    columns = {column.id: column for column in available}
    created = 0
    for rule in rules:
        conditions = stored_conditions(rule)
        resolved = [columns.get(condition.column_id) for condition in conditions]
        broken = any(
            column is None or not _usable(column, condition)
            for column, condition in zip(resolved, conditions, strict=True)
        )
        if broken:
            # Сломанное правило молчит: список покажет `broken`, а удаление
            # остаётся доступным всегда.
            continue
        if not row_matches(row, conditions, columns):
            continue
        link = db.scalar(
            select(TelegramLink).where(
                TelegramLink.user_id == rule.user_id,
                TelegramLink.revoked_at.is_(None),
            )
        )
        if link is None:
            continue
        values = [
            record_value(row, column) for column in resolved if isinstance(column, TableColumn)
        ]
        key = event_key(rule.id, row_id, conditions, values)
        already = db.scalar(
            select(NotificationDelivery.id).where(
                NotificationDelivery.user_id == rule.user_id,
                NotificationDelivery.event_key == key,
            )
        )
        if already is not None:
            continue
        db.add(
            NotificationDelivery(
                user_id=rule.user_id,
                chat_id=link.chat_id,
                kind=NOTIFICATION_RULE_KIND,
                rule_id=rule.id,
                event_key=key,
                # Название правила — и есть сообщение. Тело пустое: значения
                # столбцов в текст не подставляются.
                title=rule.name,
                body="",
                status=DELIVERY_PENDING,
            )
        )
        created += 1
    db.commit()
    return created


def notify_row_written(
    db: Session, *, dormitory_id: int, table_key: str, row_id: int, actor_id: int
) -> int:
    """Хук записи строки: поставить правила и **никогда** не ломать ответ ручки.

    Падение рассылки не должно откатывать подтверждённую запись и не должно
    превращать 200 в 500. Поэтому исключение гасится здесь одним местом, а не
    девятью копиями `try/except` в ручках; в лог идёт только ключ таблицы и тип
    ошибки — ни названия правила, ни значений столбцов, ни `chat_id`.
    """
    try:
        return queue_rule_events(
            db, dormitory_id=dormitory_id, table_key=table_key, row_id=row_id, actor_id=actor_id
        )
    except Exception as error:  # падение рассылки не должно ломать ответ ручки
        # Сессия могла остаться в неудачной транзакции: откат делает её снова
        # годной для завершения запроса. Запись уже закоммичена выше, её это не
        # касается.
        db.rollback()
        logger.warning(
            "Правила уведомлений: событие таблицы %s не обработано (%s)",
            table_key,
            type(error).__name__,
        )
        return 0


def preview(
    db: Session,
    dormitory_id: int,
    *,
    name: str,
    table_key: str,
    conditions: list[RuleCondition] | list[dict[str, Any]],
) -> tuple[str | None, int]:
    """Предпросмотр правила: сколько строк подходит и какой текст уйдёт.

    Текст берётся из той же величины, что уходит в доставку, — названия правила.
    Клиент показывает его как есть и никогда не склеивает сообщение сам. Если
    подходящих строк нет, текста нет: предпросмотр пуст.
    """
    cleaned, normalized = validate_rule(
        db, dormitory_id, name=name, table_key=table_key, conditions=conditions
    )
    columns = _table_columns(db, dormitory_id, table_key, create_missing=True)
    assert columns is not None  # validate_rule уже отверг отсутствующую таблицу
    by_id = {column.id: column for column in columns}
    rows = records_for(db, dormitory_id, table_key)
    matched = sum(1 for row in rows if row_matches(row, normalized, by_id))
    return (cleaned if matched else None), matched


def rules_for_user(db: Session, user: User, dormitory_id: int) -> list[NotificationRule]:
    """Правила пользователя в одном общежитии, новые сверху."""
    return list(
        db.scalars(
            select(NotificationRule)
            .where(
                NotificationRule.user_id == user.id,
                NotificationRule.dormitory_id == dormitory_id,
            )
            .order_by(NotificationRule.id.desc())
        )
    )


def get_rule(db: Session, user: User, dormitory_id: int, rule_id: int) -> NotificationRule:
    """Своё правило общежития. Чужое — тот же 404, что и несуществующее."""
    rule = db.get(NotificationRule, rule_id)
    if rule is None or rule.user_id != user.id or rule.dormitory_id != dormitory_id:
        raise HTTPException(404, RULE_NOT_FOUND_DETAIL)
    return rule


def create_rule(
    db: Session,
    user: User,
    dormitory_id: int,
    *,
    name: str,
    table_key: str,
    is_enabled: bool,
    conditions: list[RuleCondition] | list[dict[str, Any]],
) -> NotificationRule:
    """Завести правило пользователя. Коммитит вызывающий."""
    cleaned, normalized = validate_rule(
        db, dormitory_id, name=name, table_key=table_key, conditions=conditions
    )
    rule = NotificationRule(
        user_id=user.id,
        dormitory_id=dormitory_id,
        table_key=table_key,
        name=cleaned,
        is_enabled=is_enabled,
        conditions=[_condition_json(item) for item in normalized],
    )
    db.add(rule)
    db.flush()
    return rule


def update_rule(
    db: Session,
    user: User,
    dormitory_id: int,
    rule_id: int,
    *,
    name: str,
    table_key: str,
    is_enabled: bool,
    conditions: list[RuleCondition] | list[dict[str, Any]],
) -> NotificationRule:
    """Переписать правило целиком. Коммитит вызывающий."""
    rule = get_rule(db, user, dormitory_id, rule_id)
    cleaned, normalized = validate_rule(
        db, dormitory_id, name=name, table_key=table_key, conditions=conditions
    )
    rule.name = cleaned
    rule.table_key = table_key
    rule.is_enabled = is_enabled
    rule.conditions = [_condition_json(item) for item in normalized]
    db.flush()
    return rule


def delete_rule(db: Session, user: User, dormitory_id: int, rule_id: int) -> None:
    """Удалить своё правило. Коммитит вызывающий.

    Доставки не удаляются: `notification_deliveries.rule_id` получает `NULL`
    (`ON DELETE SET NULL`), и история отправленного остаётся целой.
    """
    rule = get_rule(db, user, dormitory_id, rule_id)
    db.delete(rule)
    db.flush()


def _condition_json(condition: RuleCondition) -> dict[str, Any]:
    return {
        "column_id": condition.column_id,
        "operator": condition.operator,
        "value": condition.value,
    }
