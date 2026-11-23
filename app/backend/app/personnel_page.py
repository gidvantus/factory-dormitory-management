"""Фильтры, порядок и превью блоков серверной страницы персонала (#247).

Здесь построчно перенесены клиентские правила: `filterPeople`, `matches`,
`personName` из `app/frontend/src/workspace/personnel/helpers.ts` и
`columnFilterPredicate`, `employeeListFields`, `employeeFieldValues`,
`sourceValues`, `matchesValues` из `employeeListFilters.ts`. Порт односторонний:
сервер отвечает на те же вопросы, которые раньше решал браузер над полной
выборкой, поэтому набор людей и их порядок совпадают с прежними.

Модуль работает только со словарями-карточками из `app.personnel.workspace`:
в базу он не ходит и своего состояния не держит.
"""

import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

# Порядок букв русского алфавита: коллатор браузера раскладывает ФИО по нему, а не
# по коду символа, поэтому «Ёлкин» идёт после «Ежова», а не рядом с «Я».
ALPHABET = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя"
STANDARD_FIELDS: tuple[tuple[str, str], ...] = (
    ("residence_status", "select"),
    ("full_name", "text"),
    ("personnel_number", "text"),
    ("phone", "text"),
    ("dormitory", "select"),
    ("hostel_name", "text"),
    ("shift_start", "date"),
    ("shift_end", "date"),
)
# Блоки по умолчанию, если пользователь не сохранял свои настройки. Тот же набор и
# в том же порядке задаёт `defaultBlocks` в helpers.ts.
DEFAULT_BLOCKS: list[dict[str, Any]] = [
    {
        "id": f"default-{index}",
        "kind": kind,
        "title": title,
        "scope": [],
        "days": 7 if kind == "plans" else 5,
        "limit": 4,
        "wide": False,
        "saved_list_id": None,
    }
    for index, (kind, title) in enumerate(
        (
            ("plans", "План заездов"),
            ("residents", "Проживающий персонал"),
            ("ending", "Заканчивается вахта"),
            ("contacts", "Контакты сотрудников"),
        )
    )
]
DIGITS = re.compile(r"\D")
PHONE_QUERY = re.compile(r"[+\d\s()\-]+")
WHITESPACE = re.compile(r"\s+")
# Значение, которое браузерный `Date.parse` не разобрал бы: в фильтр оно не проходит.
NO_DATE = 10**6


@dataclass(frozen=True)
class ColumnRule:
    """Одно условие по столбцу — `EmployeeColumnFilter` из контракта фронтенда."""

    field: str
    operator: str
    value: str = ""


@dataclass(frozen=True)
class ListCriteria:
    """Условия списка: поля `SavedList` без `id` и `name` плюс поля блока."""

    filter: str = "all"
    dormitory: int | None = None
    days: int = 5
    query: str = ""
    scope: tuple[int, ...] = ()
    column_filters: tuple[ColumnRule, ...] = ()

    def allowed(self, dormitory_id: int | None) -> bool:
        """Общежитие проходит выбор области — как `allowed` в `filterPeople`."""
        if dormitory_id is None:
            return False
        return (self.dormitory is None or self.dormitory == dormitory_id) and (
            not self.scope or dormitory_id in self.scope
        )

    @property
    def scoped(self) -> bool:
        return self.dormitory is not None or bool(self.scope)


@dataclass(frozen=True)
class ListField:
    """Поле условий: стандартное поле карточки или столбец исходной таблицы."""

    id: str
    kind: str
    table: str | None = None
    columns: tuple[dict[str, Any], ...] = ()


def normalize(text: str) -> str:
    """Сравнение без учёта регистра, ё и повторных пробелов."""
    return WHITESPACE.sub(" ", text.strip().lower().replace("ё", "е"))


def scalar(value: Any) -> str:
    """`scalar` из `employeeListFilters.ts`: bool — Да/Нет, остальное — строка."""
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (str, int, float)):
        return str(value).strip()
    return ""


def number(value: str) -> float | None:
    """`Number(...)`: запятая как разделитель, всё нечисловое — не число."""
    try:
        result = float(value.replace(",", "."))
    except ValueError:
        return None
    return result if math.isfinite(result) else None


def shift_end(source: dict[str, Any] | None) -> str:
    return scalar((source or {}).get("values", {}).get("shift_end"))


def day_diff(start: str, end: str) -> int:
    try:
        return (date.fromisoformat(end[:10]) - date.fromisoformat(start[:10])).days
    except ValueError:
        return NO_DATE


def add_days(day: str, days: int) -> str:
    """`addDays` из `helpers.ts`: сдвиг по календарю, формат `YYYY-MM-DD`."""
    try:
        start = date.fromisoformat(day[:10])
    except ValueError:
        return day
    return (start + timedelta(days=days)).isoformat()


def matches_shift(person: dict[str, Any], criteria: ListCriteria, today: str) -> bool:
    """`matches`: проживает сейчас или вахта кончается в ближайшие `days` дней."""
    current = [source for source in person["current"] if criteria.allowed(source["dormitory_id"])]
    if criteria.filter == "current":
        return bool(current)
    if criteria.filter == "ending":
        return any(
            end >= today and day_diff(today, end) <= criteria.days
            for end in (shift_end(source) for source in current)
            if end
        )
    return True


def query_matches(person: dict[str, Any], query: str, digits: str) -> bool:
    """Текстовый поиск: ФИО, табельный, телефон, варианты, плюс поиск по цифрам."""
    if not query:
        return True
    text = " ".join(
        [
            person["full_name"] or "",
            person["personnel_number"] or "",
            person["phone"] or "",
            *(value for values in person["variants"].values() for value in values),
        ]
    )
    if query in text.lower().replace("ё", "е"):
        return True
    if not (PHONE_QUERY.fullmatch(query) and len(digits) >= 3):
        return False
    phones = [person["phone"] or "", *person["variants"].get("phone", [])]
    return any(digits in DIGITS.sub("", phone) for phone in phones)


def active_rule(rule: ColumnRule) -> bool:
    """`activeColumnFilter`: пустое условие сравнения ничего не фильтрует."""
    return rule.operator in ("empty", "filled") or bool(rule.value.strip())


def list_fields(
    source_columns: list[dict[str, Any]], criteria: ListCriteria
) -> dict[str, ListField]:
    """`employeeListFields`: стандартные поля и столбцы таблиц области."""
    fields = {id: ListField(id, kind) for id, kind in STANDARD_FIELDS}
    grouped: dict[str, list[dict[str, Any]]] = {}
    for column in source_columns:
        if not criteria.allowed(column["dormitory_id"]):
            continue
        name = column["builtin_key"] or normalize(column["name"])
        grouped.setdefault(f"source:{column['table_key']}:{name}:{column['kind']}", []).append(
            column
        )
    for id, columns in grouped.items():
        fields[id] = ListField(id, columns[0]["kind"], columns[0]["table_key"], tuple(columns))
    return fields


def source_values(field: ListField, source: dict[str, Any]) -> list[str]:
    """`sourceValues`: значения ячеек строки по столбцам её общежития и таблицы."""
    values: list[str] = []
    for column in field.columns:
        if (column["dormitory_id"], column["table_key"]) != (
            source["dormitory_id"],
            source["table_key"],
        ):
            continue
        raw = (
            source["values"].get(column["builtin_key"])
            if column["builtin_key"]
            else (source["values"].get("custom_values") or {}).get(str(column["id"]))
        )
        text = scalar(raw)
        if column["kind"] == "select":
            text = next(
                (option["label"] for option in column["options"] if option["id"] == text), text
            )
        values.append(text)
    return values


def employee_field_values(
    person: dict[str, Any],
    field: ListField,
    dormitories: list[dict[str, Any]],
    criteria: ListCriteria,
) -> list[str]:
    """`employeeFieldValues`: значения поля у человека в пределах области."""
    current = [source for source in person["current"] if criteria.allowed(source["dormitory_id"])]
    values: list[str]
    if field.table:
        values = [
            value
            for source in person["sources"]
            if criteria.allowed(source["dormitory_id"])
            for value in source_values(field, source)
        ]
    elif field.id == "residence_status":
        values = ["Проживает" if current else "Вне общежитий"]
    elif field.id == "dormitory":
        names = {dormitory["id"]: dormitory["name"] for dormitory in dormitories}
        values = [names.get(source["dormitory_id"], "") for source in current]
    elif field.id in ("full_name", "personnel_number", "phone"):
        values = [person[field.id] or "", *person["variants"].get(field.id, [])]
    else:
        values = [scalar(source["values"].get(field.id)) for source in current]
    return list(dict.fromkeys(value for value in values if value.strip()))


def matches_values(values: list[str], rule: ColumnRule, field: ListField) -> bool:
    """`matchesValues`: сравнение значений поля с одним условием."""
    filled = [value for value in values if value.strip()]
    if rule.operator == "empty":
        return not filled
    if rule.operator == "filled":
        return bool(filled)
    expected = normalize(rule.value)
    expected_digits = DIGITS.sub("", expected)
    for value in filled:
        actual = normalize(value)
        if rule.operator == "contains":
            if field.id == "phone" and PHONE_QUERY.fullmatch(expected) and expected_digits:
                if expected_digits in DIGITS.sub("", actual):
                    return True
            elif expected in actual:
                return True
            continue
        if field.kind == "number":
            left, right = number(actual), number(expected)
            if left is None or right is None:
                continue
            if (rule.operator == "equals" and left == right) or (
                rule.operator == "from" and left >= right
            ):
                return True
            if rule.operator == "to" and left <= right:
                return True
            continue
        if rule.operator == "equals" and actual == expected:
            return True
        if rule.operator == "from" and actual >= expected:
            return True
        if rule.operator == "to" and actual <= expected:
            return True
    return False


def column_predicate(
    criteria: ListCriteria,
    source_columns: list[dict[str, Any]],
    dormitories: list[dict[str, Any]],
) -> Callable[[dict[str, Any]], bool]:
    """`columnFilterPredicate`: условия по столбцам, одна строка на таблицу."""
    fields = list_fields(source_columns, criteria)
    rules = [rule for rule in criteria.column_filters if active_rule(rule)]

    def predicate(person: dict[str, Any]) -> bool:
        groups: dict[str, list[tuple[ColumnRule, ListField]]] = {}
        for rule in rules:
            field = fields.get(rule.field)
            if field is None:
                return False
            if field.table is None:
                values = employee_field_values(person, field, dormitories, criteria)
                if not matches_values(values, rule, field):
                    return False
            else:
                groups.setdefault(field.table, []).append((rule, field))
        for table, group in groups.items():
            if not any(
                source["table_key"] == table
                and criteria.allowed(source["dormitory_id"])
                and all(
                    any(
                        column["dormitory_id"] == source["dormitory_id"] for column in field.columns
                    )
                    and matches_values(source_values(field, source), rule, field)
                    for rule, field in group
                )
                for source in person["sources"]
            ):
                return False
        return True

    return predicate


def filtered(
    cards: list[dict[str, Any]],
    criteria: ListCriteria,
    today: str,
    dormitories: list[dict[str, Any]],
    source_columns: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Люди, проходящие условия списка (без сортировки) — `filterPeople`."""
    matches_columns = (
        column_predicate(criteria, source_columns, dormitories)
        if any(active_rule(rule) for rule in criteria.column_filters)
        else None
    )
    query = criteria.query.strip().lower().replace("ё", "е")
    digits = DIGITS.sub("", query)
    result = []
    for person in cards:
        if criteria.scoped and not (
            any(criteria.allowed(source["dormitory_id"]) for source in person["sources"])
            or any(criteria.allowed(id) for id in person["history_dormitory_ids"])
        ):
            continue
        if not matches_shift(person, criteria, today):
            continue
        if matches_columns is not None and not matches_columns(person):
            continue
        if not query_matches(person, query, digits):
            continue
        result.append(person)
    return result


def russian_key(text: str) -> tuple[tuple[int, int], ...]:
    """Ключ порядка: буквы по русскому алфавиту, остальные символы — по коду."""
    return tuple(
        (1, ALPHABET.index(character)) if character in ALPHABET else (0, ord(character))
        for character in text.lower()
    )


def person_name(person: dict[str, Any]) -> str:
    return person["full_name"] or "ФИО не указано"


def earliest_end(person: dict[str, Any], criteria: ListCriteria) -> str:
    ends = sorted(
        end
        for source in person["current"]
        if criteria.allowed(source["dormitory_id"])
        for end in (shift_end(source),)
        if end
    )
    return ends[0] if ends else ""


def ordered(people: list[dict[str, Any]], criteria: ListCriteria) -> list[dict[str, Any]]:
    """Порядок клиента: при `ending` — по раннему концу вахты, дальше ФИО и `id`."""
    if criteria.filter == "ending":
        return sorted(
            people,
            key=lambda person: (
                earliest_end(person, criteria),
                russian_key(person_name(person)),
                person["id"],
            ),
        )
    return sorted(people, key=lambda person: (russian_key(person_name(person)), person["id"]))


def page(
    cards: list[dict[str, Any]],
    criteria: ListCriteria,
    today: str,
    dormitories: list[dict[str, Any]],
    source_columns: list[dict[str, Any]],
    number: int,
    per_page: int,
) -> tuple[list[dict[str, Any]], int]:
    """Карточки запрошенной страницы и общее число людей в списке.

    Сортировка и срез идут по одному и тому же отфильтрованному списку, поэтому
    страницы вместе дают `total` без пропусков и повторов.
    """
    people = ordered(filtered(cards, criteria, today, dormitories, source_columns), criteria)
    start = (number - 1) * per_page
    return people[start : start + per_page], len(people)


def block_source(
    person: dict[str, Any], criteria: ListCriteria, today: str
) -> dict[str, Any] | None:
    """`blockSource`: текущая запись, попавшая в фильтр, а не прошлая вахта человека."""
    candidates = [
        source
        for source in person["current"]
        if criteria.allowed(source["dormitory_id"])
        and (
            criteria.filter != "ending"
            or (shift_end(source) >= today and day_diff(today, shift_end(source)) <= criteria.days)
        )
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda source: shift_end(source) or "9999")


def block_criteria(
    block: dict[str, Any],
    dormitory: int | None,
    lists: list[dict[str, Any]],
) -> tuple[ListCriteria, bool]:
    """`blockCriteria`: условия блока и признак потерянного сохранённого списка."""
    saved = (
        next((item for item in lists if item["id"] == block["saved_list_id"]), None)
        if block["kind"] == "saved"
        else None
    )
    missing = block["kind"] == "saved" and saved is None
    kind = block["kind"]
    if kind == "saved":
        filter = (saved or {}).get("filter") or "all"
    elif kind in ("residents", "contacts"):
        filter = "current"
    else:
        filter = "ending"
    scope = block["scope"] or (saved or {}).get("scope") or []
    criteria = ListCriteria(
        filter=filter,
        dormitory=dormitory if dormitory is not None else (saved or {}).get("dormitory"),
        days=(saved or {}).get("days") or block["days"],
        query=(saved or {}).get("query") or "",
        scope=tuple(scope),
        column_filters=tuple(
            ColumnRule(rule["field"], rule["operator"], rule.get("value") or "")
            for rule in (saved or {}).get("column_filters") or []
        ),
    )
    return criteria, missing


def block_previews(
    *,
    cards: list[dict[str, Any]],
    lists: list[dict[str, Any]],
    blocks: list[dict[str, Any]] | None,
    today: str,
    dormitory: int | None,
    dormitories: list[dict[str, Any]],
    source_columns: list[dict[str, Any]],
    arrivals: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Данные блоков рабочей поверхности без полной выборки карточек (#247).

    Блок рисовался из общего массива сотрудников; при `?employees=none` массива
    больше нет, поэтому счётчик, первые карточки, события для диаграммы и разбивка
    по общежитиям считаются здесь. Подписи дат, цвета и легенда остаются на клиенте.
    """
    previews = []
    for block in blocks if blocks is not None else DEFAULT_BLOCKS:
        criteria, missing = block_criteria(block, dormitory, lists)
        if block["kind"] == "plans":
            selected = sorted(
                (
                    plan
                    for plan in arrivals
                    if criteria.allowed(plan["dormitory_id"])
                    and today <= plan["date"] <= add_days(today, block["days"])
                ),
                key=lambda plan: (plan["date"], plan["id"]),
            )
            previews.append(
                {
                    "id": block["id"],
                    "kind": block["kind"],
                    "title": block["title"],
                    "count": sum(plan["count"] for plan in selected),
                    "items": [],
                    "events": [{"date": plan["date"], "count": plan["count"]} for plan in selected],
                    "dorms": [],
                    "missing_list": False,
                }
            )
            continue
        people = [] if missing else filtered(cards, criteria, today, dormitories, source_columns)
        if criteria.filter == "ending":
            people.sort(key=lambda person: shift_end(block_source(person, criteria, today)))
        events = (
            [
                {"date": end, "count": 1}
                for person in people
                for end in (shift_end(block_source(person, criteria, today)),)
                if end
            ]
            if block["kind"] == "ending"
            else []
        )
        dorms = (
            [
                {
                    "id": item["id"],
                    "name": item["name"],
                    "client_name": item["client_name"],
                    "is_archived": item["is_archived"],
                    "count": sum(
                        1
                        for person in people
                        if any(source["dormitory_id"] == item["id"] for source in person["current"])
                    ),
                }
                for item in dormitories
                if criteria.allowed(item["id"])
            ]
            if block["kind"] == "residents"
            else []
        )
        previews.append(
            {
                "id": block["id"],
                "kind": block["kind"],
                "title": block["title"],
                "count": len(people),
                "items": people[: int(block["limit"])],
                "events": events,
                "dorms": dorms,
                "missing_list": missing,
            }
        )
    return previews
