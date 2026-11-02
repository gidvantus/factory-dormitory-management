"""Проверка структуры, постоянных ссылок и расчёт значений конструктора персонала."""

import re
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import HTTPException

from app.personnel_builder_sources import Sources, normalized
from app.report_formula import FormulaError, calculate_formula, compile_formula
from app.schemas.personnel_builder import BuilderState, Evaluation, Link, LinkFilter, Row, Rule, Tab

BUILTINS = {"workspace", "employees", "planning"}
RESERVED_NAMES = {"рабочая поверхность", "сотрудники", "план заездов"}


def computed(rule: Rule | None) -> bool:
    return rule is not None and rule.mode != "manual"


def row_name(tab: Tab, row: Row) -> str:
    if row.name:
        return row.name
    first = next((c for c in tab.columns if not c.archived), None)
    return str(row.values.get(first.id, "")) if first else row.id


def local_sources(state: BuilderState) -> list[dict[str, Any]]:
    return [
        {
            "id": f"tab:{t.id}",
            "name": t.name,
            "kind": "calendar" if t.tableOptions.table_format == "calendar" else "table",
            "fields": [
                *(
                    {"id": c.id, "name": c.name, "kind": c.kind}
                    for c in t.columns
                    if not c.archived
                ),
                *(
                    [
                        {"id": "$date", "name": "Дата", "kind": "date"},
                        {"id": "$value", "name": "Значение за день", "kind": "number"},
                    ]
                    if t.tableOptions.table_format == "calendar"
                    else []
                ),
            ],
            **(
                {"rows": [{"id": r.id, "name": row_name(t, r)} for r in t.rows]}
                if t.tableOptions.table_format == "calendar"
                else {}
            ),
        }
        for t in state.tabs
        if t.kind == "table" and not t.isGroup and not t.archived
    ]


def dependencies(tab: Tab, axis: str, rule: Rule | None, tabs: dict[str, Tab]) -> list[str]:
    if not computed(rule) or rule is None:
        return []
    if rule.mode == "formula":
        return [f"{tab.id}:{axis}:{id}" for id in rule.refs.values()]
    link = rule.link
    if link is None:
        return []
    result = [f"{tab.id}:column:{link.match.localColumnId}"] if link.match else []
    source = (
        tabs.get(link.sourceId.removeprefix("tab:")) if link.sourceId.startswith("tab:") else None
    )
    if source:
        fields = [
            *([link.valueField] if link.operation != "count" else []),
            *(f.field for f in link.filters),
            *([link.dateField] if link.dateField else []),
            *([link.match.sourceField] if link.match else []),
        ]
        result.extend(
            f"{source.id}:column:{field}" for field in fields if not field.startswith("$")
        )
        if source.tableOptions.table_format == "calendar" and link.sourceRowId:
            result.append(f"{source.id}:row:{link.sourceRowId}")
    return list(dict.fromkeys(result))


def validate_state(state: BuilderState, env: Sources, previous: BuilderState | None = None) -> None:
    tabs = {tab.id: tab for tab in state.tabs}
    if len(tabs) != len(state.tabs) or set(tabs) & BUILTINS:
        raise HTTPException(422, "Идентификаторы подвкладок должны отличаться от основных разделов")
    names = [normalized(t.name) for t in state.tabs]
    if len(set(names)) != len(names) or set(names) & RESERVED_NAMES:
        raise HTTPException(422, "Названия подвкладок должны отличаться, включая архивные")
    sources = {source["id"]: source for source in [*env.catalog(), *local_sources(state)]}
    employee_ids = {
        id for person in env.personnel["employees"] for id in [person["id"], *person["member_ids"]]
    }
    retained_employees = {
        str(value)
        for t in (previous.tabs if previous else [])
        for r in t.rows
        for c in t.columns
        if c.kind == "employee"
        for value in [r.values.get(c.id)]
        if value
    }
    edges: dict[str, list[str]] = {}
    labels: dict[str, str] = {}
    for tab in state.tabs:
        if tab.parentId:
            parent = tabs.get(tab.parentId)
            if (
                not parent
                or parent.parentId
                or not parent.isGroup
                or parent.kind != "table"
                or tab.kind != "table"
                or tab.isGroup
            ):
                raise HTTPException(
                    422, "Вложенная таблица должна принадлежать группе таблиц одного уровня"
                )
        elif tab.isGroup and tab.kind != "table":
            raise HTTPException(422, "Группа должна содержать таблицы")
        scope = [
            *tab.criteria.scope,
            *([tab.criteria.dormitory] if tab.criteria.dormitory else []),
            *(id for b in tab.blocks for id in b.scope),
        ]
        if any(id not in env.dorms for id in scope):
            raise HTTPException(422, "Одно из общежитий недоступно в вашей организации")
        column_ids = {c.id for c in tab.columns}
        if len(column_ids) != len(tab.columns) or len({r.id for r in tab.rows}) != len(tab.rows):
            raise HTTPException(422, "Идентификаторы столбцов и строк должны отличаться")
        if tab.kind == "table":
            columns = [c for c in tab.columns if not c.archived]
            titles = [normalized(c.name) for c in columns]
            if not titles or any(not name for name in titles) or len(set(titles)) != len(titles):
                raise HTTPException(422, f"{tab.name}: заполните разные названия столбцов")
            if (
                tab.tableOptions.table_format == "list"
                and tab.tableOptions.period_mode != "none"
                and not any(c.id == tab.dateColumnId and c.kind == "date" for c in columns)
            ):
                raise HTTPException(422, "Выберите действующий столбец даты для периода")
            for row in tab.rows:
                if any(id not in column_ids for id in row.values):
                    raise HTTPException(422, "В записи указан неизвестный столбец")
                for column in tab.columns:
                    value = row.values.get(column.id)
                    if (
                        column.kind == "employee"
                        and value
                        and value not in employee_ids
                        and str(value) not in retained_employees
                    ):
                        raise HTTPException(422, "Сотрудник недоступен в вашей организации")
                    if (
                        not computed(column.rule)
                        and not column.archived
                        and value not in (None, "")
                    ):
                        if column.kind == "checkbox" and type(value) is not bool:
                            raise HTTPException(422, "Для чекбокса требуется логическое значение")
                        if column.kind == "number":
                            number(value)
                        if column.kind == "date":
                            try:
                                date.fromisoformat(str(value))
                            except ValueError as exc:
                                raise HTTPException(422, "Проверьте дату ячейки") from exc
                        if column.kind == "select" and value not in column.options:
                            raise HTTPException(422, "Вариант списка не найден")
                    if (
                        column.required
                        and not computed(column.rule)
                        and not computed(row.rule)
                        and (tab.tableOptions.table_format == "list" or not row.name)
                        and (
                            value in (None, "") or (column.kind == "checkbox" and value is not True)
                        )
                    ):
                        raise HTTPException(422, f"Заполните поле «{column.name}»")
        if tab.kind == "blocks" and not tab.blocks:
            raise HTTPException(422, "Выберите хотя бы один рабочий блок")
        # Правила группы — образец для новых таблиц, а не действующий источник данных.
        if tab.archived or tab.isGroup or tab.kind != "table":
            continue
        for axis, items in (
            ("column", [c for c in tab.columns if not c.archived]),
            ("row", tab.rows),
        ):
            ids = {item.id for item in items}
            for item in items:
                key = f"{tab.id}:{axis}:{item.id}"
                labels[key] = f"{tab.name} → {item.name or item.id}"
                rule = item.rule
                try:
                    if rule and rule.mode == "formula":
                        _, refs = compile_formula(rule.expression)
                        bracket_refs = set(re.findall(r"\[([^\[\]]+)\]", rule.expression))
                        if refs != bracket_refs or any(
                            rule.refs.get(name) not in ids for name in refs
                        ):
                            raise FormulaError("Не найдена ссылка формулы; используйте [название]")
                    if rule and rule.mode == "link":
                        link = rule.link
                        source = sources.get(link.sourceId) if link else None
                        if not source or not link:
                            raise FormulaError("Источник связи не найден или недоступен")
                        fields = {field["id"] for field in source["fields"]}
                        used = [
                            *([link.valueField] if link.operation != "count" else []),
                            *(f.field for f in link.filters),
                            *([link.dateField] if link.dateField else []),
                            *([link.match.sourceField] if link.match else []),
                        ]
                        if any(field not in fields for field in used):
                            raise FormulaError("Столбец источника не найден или скрыт")
                        if "rows" in source and link.sourceRowId not in {
                            r["id"] for r in source["rows"]
                        }:
                            raise FormulaError("Строка источника не найдена")
                        if link.match and not any(
                            c.id == link.match.localColumnId and not c.archived for c in tab.columns
                        ):
                            raise FormulaError("Столбец сопоставления не найден")
                        if link.dateField and not any(
                            f["id"] == link.dateField and f["kind"] == "date"
                            for f in source["fields"]
                        ):
                            raise FormulaError("Для отбора по дате нужен столбец даты")
                        if any(
                            f.operator not in ("empty", "not_empty") and not f.value.strip()
                            for f in link.filters
                        ):
                            raise FormulaError("Заполните значения условий связи")
                    edges[key] = dependencies(tab, axis, rule, tabs)
                except (FormulaError, RecursionError) as exc:
                    raise HTTPException(422, f"{labels[key]}: {exc}") from exc
    path: list[str] = []
    done: set[str] = set()

    def visit(key: str) -> None:
        if key in path:
            raise HTTPException(
                422,
                "Циклическая зависимость: "
                + " → ".join(labels.get(id, id) for id in [*path[path.index(key) :], key]),
            )
        if key in done:
            return
        if len(path) > 100:
            raise HTTPException(422, "Слишком длинная цепочка расчётов")
        path.append(key)
        for dependency in edges[key]:
            if dependency not in edges:
                raise HTTPException(
                    409, f"Зависимость {labels[key]} недоступна. Сначала измените правило"
                )
            visit(dependency)
        path.pop()
        done.add(key)

    for key in edges:
        visit(key)
    default = tabs.get(state.defaultTab)
    if state.defaultTab not in BUILTINS and (
        not default
        or default.archived
        or default.hidden
        or (default.parentId and (tabs[default.parentId].hidden or tabs[default.parentId].archived))
    ):
        raise HTTPException(422, "Вкладка для открытия первой должна быть доступна")


def number(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal(0)
    if type(value) is bool:
        return Decimal(int(value))
    if value in ("Да", "Нет"):
        return Decimal(int(value == "Да"))
    try:
        result = Decimal(str(value).strip().replace(",", "."))
        if not result.is_finite():
            raise InvalidOperation
        return result
    except (InvalidOperation, ValueError) as exc:
        raise FormulaError(f"«{str(value)[:100]}» не является числом") from exc


class Engine:
    def __init__(self, state: BuilderState, env: Sources, request: Evaluation):
        self.state, self.env, self.request = state, env, request
        self.tabs = {t.id: t for t in state.tabs}
        self.catalog = {s["id"]: s for s in [*env.catalog(), *local_sources(state)]}
        self.cache: dict[str, Any] = {}
        self.stack: set[str] = set()
        self.employee_roots = {
            id: person["id"]
            for person in env.personnel["employees"]
            for id in [person["id"], *person["member_ids"]]
        }
        self.budget = 2_000_000

    def tick(self) -> None:
        self.budget -= 1
        if self.budget < 0:
            raise FormulaError(
                "Слишком большой расчёт. Сократите период или уточните условия связи"
            )

    def days(self, day: str | None = None, tab: Tab | None = None) -> list[str]:
        if day or self.request.day:
            return [day or self.request.day or ""]
        if self.request.from_date and self.request.to_date:
            return [
                (self.request.from_date + timedelta(days=i)).isoformat()
                for i in range((self.request.to_date - self.request.from_date).days + 1)
            ]
        return (
            (
                sorted({key for row in tab.rows for key in row.dayValues})
                or [str(self.env.personnel["today"])]
            )
            if tab
            else [str(self.env.personnel["today"])]
        )

    def value(self, tab: Tab, row: Row, id: str | None = None, day: str | None = None) -> Any:
        self.tick()
        key = f"{tab.id}:{row.id}:{id}:{day}"
        if key in self.stack or len(self.stack) > 100:
            raise FormulaError("Циклическая или слишком длинная зависимость расчётов")
        if key in self.cache:
            return self.cache[key]
        self.stack.add(key)
        try:
            column = (
                next((c for c in tab.columns if c.id == id and not c.archived), None)
                if id
                else None
            )
            if id and not column:
                raise FormulaError("Столбец зависимости не найден")
            rule = column.rule if column else row.rule
            if not computed(rule) or rule is None:
                result: Any = row.values.get(id, "") if id else row.dayValues.get(day or "", "")
            elif rule.mode == "link":
                result = self.linked(tab, row, rule.link, day)
            else:
                tree, _ = compile_formula(rule.expression)

                def resolve(name: str) -> Decimal:
                    target_id = rule.refs.get(name)
                    if not target_id:
                        raise FormulaError(f"Не найдена ссылка [{name}]")
                    if id:
                        return number(self.value(tab, row, target_id))
                    target = next((r for r in tab.rows if r.id == target_id), None)
                    if not target:
                        raise FormulaError(f"Не найдена строка [{name}]")
                    return number(self.value(tab, target, day=day))

                result = calculate_formula(tree, resolve)
            if isinstance(result, Decimal):
                if not result.is_finite() or abs(result) > Decimal("1e15"):
                    raise FormulaError("Результат вне допустимого диапазона")
                result = int(result) if result == result.to_integral_value() else float(result)
            self.cache[key] = result
            return result
        finally:
            self.stack.remove(key)

    def linked(self, tab: Tab, row: Row, link: Link | None, day: str | None) -> Any:
        if not link:
            raise FormulaError("Связь не настроена")
        source = self.catalog.get(link.sourceId)
        if not source:
            raise FormulaError("Источник связи не найден или находится в архиве")

        def records() -> list[dict[str, list[Any]]]:
            if link.sourceId.startswith("tab:"):
                target = self.tabs[link.sourceId[4:]]
                result: list[dict[str, list[Any]]] = []
                for item in target.rows:
                    if source["kind"] == "calendar" and link.sourceRowId != item.id:
                        continue
                    for date_key in (
                        self.days(day, target) if source["kind"] == "calendar" else [None]
                    ):
                        # Читать вычисляемые поля нужно лениво: фильтр может исключить запись.
                        result.append(
                            {
                                "$target": [target, item, date_key],
                                "$row_id": [item.id],
                                "$date": [date_key],
                            }
                        )
                return result
            days = self.days(day)
            return self.env.records(
                link.sourceId, date.fromisoformat(days[0]), date.fromisoformat(days[-1])
            )

        def read(record: dict[str, list[Any]], field: str) -> list[Any]:
            if error := record.get("$errors", [{}])[0].get(field):
                raise FormulaError(str(error))
            if "$target" in record and field not in ("$row_id", "$date"):
                target, item, date_key = record["$target"]
                return [
                    self.value(target, item, day=date_key)
                    if field == "$value"
                    else self.value(target, item, field)
                ]
            if field == "$value" and record.get("$error", [""])[0]:
                raise FormulaError(f"Ошибка источника: {record['$error'][0]}")
            return record.get(field, [])

        def matches(record: dict[str, list[Any]]) -> bool:
            self.tick()
            if "rows" in source and link.sourceRowId not in read(record, "$row_id"):
                return False
            if link.match:
                local = self.value(tab, row, link.match.localColumnId)
                employee_field = any(
                    f["id"] == link.match.sourceField and f["kind"] == "employee"
                    for f in source["fields"]
                )

                def identity(value: Any) -> str:
                    return normalized(
                        self.employee_roots.get(str(value), str(value)) if employee_field else value
                    )

                if local in (None, "") or identity(local) not in {
                    identity(v) for v in read(record, link.match.sourceField)
                }:
                    return False
            for condition in link.filters:
                values = [
                    v for v in read(record, condition.field) if v is not None and str(v).strip()
                ]
                if condition.operator in ("empty", "not_empty"):
                    if bool(values) != (condition.operator == "not_empty"):
                        return False
                    continue
                kind = next(f["kind"] for f in source["fields"] if f["id"] == condition.field)

                def compare(
                    value: Any, condition: LinkFilter = condition, kind: str = kind
                ) -> bool:
                    if condition.operator == "contains":
                        return normalized(condition.value) in normalized(value)
                    actual: Any = number(value) if kind == "number" else normalized(value)
                    expected: Any = (
                        number(condition.value) if kind == "number" else normalized(condition.value)
                    )
                    if condition.operator == "equals":
                        if kind == "checkbox":
                            actual = {"да": "true", "нет": "false"}.get(actual, actual)
                            expected = {"да": "true", "нет": "false"}.get(expected, expected)
                        return actual == expected
                    return (
                        actual >= expected if condition.operator == "from" else actual <= expected
                    )

                if not any(compare(value) for value in values):
                    return False
            if link.dateField:
                days = self.days(day)
                if (day or self.request.day or self.request.from_date) and not any(
                    days[0] <= str(value or "") <= days[-1]
                    for value in read(record, link.dateField)
                ):
                    return False
            return True

        candidates = [record for record in records() if matches(record)]

        def empty() -> Any:
            if link.empty == "error":
                raise FormulaError("Подходящих записей не найдено")
            return "" if link.empty == "blank" else 0

        if link.operation == "count":
            return len(candidates)
        if not candidates:
            return empty()
        if link.operation == "lookup":
            if len(candidates) != 1:
                raise FormulaError(
                    f"Ожидалась одна запись, найдено {len(candidates)}. Уточните условия"
                )
            values = [v for v in read(candidates[0], link.valueField) if v not in (None, "")]
            if source["id"] == "people" and link.valueField == "$employee":
                values = values[:1]
            if len(values) > 1:
                raise FormulaError("В записи источника несколько значений")
            return values[0] if values else empty()
        values = [
            number(v)
            for record in candidates
            for v in read(record, link.valueField)
            if v not in (None, "")
        ]
        if not values:
            return empty()
        if link.operation == "sum":
            return sum(values, Decimal(0))
        if link.operation == "average":
            return sum(values, Decimal(0)) / len(values)
        return min(values) if link.operation == "min" else max(values)

    def cell(
        self, tab: Tab, row: Row, id: str | None = None, day: str | None = None
    ) -> dict[str, Any]:
        try:
            return {"value": self.value(tab, row, id, day)}
        except (
            FormulaError,
            InvalidOperation,
            OverflowError,
            ValueError,
            RecursionError,
            HTTPException,
        ) as exc:
            return {
                "value": None,
                "error": str(exc.detail) if isinstance(exc, HTTPException) else str(exc),
            }

    def evaluate(self) -> dict[str, Any]:
        tab = self.tabs.get(self.request.tabId)
        if not tab or tab.archived or tab.kind != "table":
            raise HTTPException(404, "Таблица не найдена")
        rows = [r for r in tab.rows if not self.request.rowId or r.id == self.request.rowId]
        if self.request.rowId and not rows:
            raise HTTPException(404, "Запись не найдена")
        if self.request.columnId or self.request.day:
            if not rows:
                raise HTTPException(404, "Добавьте запись для проверки")
            return {"cell": self.cell(tab, rows[0], self.request.columnId, self.request.day)}
        days = self.days() if tab.tableOptions.table_format == "calendar" else []
        if len(rows) * (len(days) + len(tab.columns)) > 250_000:
            raise HTTPException(422, "Для расчёта большого списка сократите период")
        return {
            "columns": {
                r.id: {
                    c.id: self.cell(tab, r, c.id)
                    for c in tab.columns
                    if not c.archived and computed(c.rule)
                }
                for r in rows
            },
            "days": {
                r.id: {day: self.cell(tab, r, day=day) for day in days}
                for r in rows
                if computed(r.rule)
            },
        }
