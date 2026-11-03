"""Связанные ячейки пользовательских таблиц. Ручные данные не перезаписываются."""

import hashlib
import json
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel
from app.models.personnel import EmployeeEvent, PersonnelBinding
from app.models.table_column import TableColumn
from app.schemas.custom_tab import TabEntryResponse
from app.schemas.table_column import CellFill
from app.section_state import SECTIONS, section_ancestors, section_status
from app.table_data import DEFAULT_COLUMNS, Record, record_value, records_for

PERSONNEL_FIELDS = {"full_name": "ФИО", "personnel_number": "Табельный номер", "phone": "Телефон"}
FILL_KINDS = {"text", "number", "date", "checkbox"}


def personnel_records(db: Session, dormitory_id: int) -> dict[str, dict[str, Any]]:
    from app.personnel import SOURCE_MODELS, group_identities, root_map

    dorm = db.get(Dormitory, dormitory_id)
    assert dorm is not None
    scope = list(
        db.scalars(select(Dormitory.id).where(Dormitory.organization_id == dorm.organization_id))
    )
    employees, roots = root_map(db)
    visible: set[str] = set()
    for model in SOURCE_MODELS:
        visible.update(
            db.scalars(
                select(model.employee_id).where(
                    model.dormitory_id.in_(scope), model.employee_id.is_not(None)
                )
            )
        )
    visible.update(
        db.scalars(select(EmployeeEvent.employee_id).where(EmployeeEvent.dormitory_id.in_(scope)))
    )
    identities = group_identities(employees, roots)
    return {roots[key]: identities[roots[key]] for key in visible if key in roots}


class FillResolver:
    """Один объект на операцию: столбцы и каждая таблица читаются один раз."""

    def __init__(self, db: Session, dormitory_id: int):
        self.db = db
        self.dormitory_id = dormitory_id
        self.dorm = db.get(Dormitory, dormitory_id)
        self.columns = {
            col.id: col
            for col in db.scalars(
                select(TableColumn).where(TableColumn.dormitory_id == dormitory_id)
            )
        }
        self.tabs = {
            tab.table_key: tab
            for tab in db.scalars(select(CustomTab).where(CustomTab.dormitory_id == dormitory_id))
        }
        self.records: dict[str, dict[str, Any]] = {}

    def available(self, source: str) -> bool:
        if source == "personnel":
            return True
        if source.startswith("custom_"):
            tab = self.tabs.get(source)
            return tab is not None and tab.table_created and tab.kind != "archive"
        return bool(
            self.dorm
            and source in DEFAULT_COLUMNS
            and all(
                section_status(self.dorm, key) != "deleted"
                for key in section_ancestors(self.dorm, source)
            )
        )

    def field(self, source: str, field: str) -> tuple[str, str]:
        if not self.available(source):
            raise HTTPException(409, "Таблица-источник недоступна. Измените связь.")
        if source == "personnel":
            if field not in PERSONNEL_FIELDS:
                raise HTTPException(422, "Поле персонала не найдено")
            return PERSONNEL_FIELDS[field], "text"
        column = self.columns.get(int(field)) if field.isdecimal() else None
        if (
            column is None
            or column.table_key != source
            or column.archived
            or column.kind == "action"
        ):
            raise HTTPException(422, "Столбец источника недоступен. Измените связь.")
        return column.name, "text" if column.kind in {"select", "hostel"} else column.kind

    def source_records(self, source: str) -> dict[str, Any]:
        if not self.available(source):
            raise HTTPException(409, "Таблица-источник недоступна")
        if source not in self.records:
            self.records[source] = (
                personnel_records(self.db, self.dormitory_id)
                if source == "personnel"
                else {str(row.id): row for row in records_for(self.db, self.dormitory_id, source)}
            )
        return self.records[source]

    def read(
        self,
        source: str,
        record_id: str,
        field: str,
        stack: frozenset[tuple[int, int]] = frozenset(),
    ) -> Any:
        self.field(source, field)
        record = self.source_records(source).get(record_id)
        if record is None:
            raise HTTPException(409, "Выбранная запись больше недоступна. Выберите другую.")
        if source == "personnel":
            return record.get(field)
        column = self.columns[int(field)]
        value = self.value(record, column, stack)
        if column.kind == "select":
            return next(
                (option["label"] for option in column.options if option["id"] == value), None
            )
        if column.kind == "hostel":
            hostel = self.db.get(Hostel, value) if value is not None else None
            return hostel.name if hostel and hostel.dormitory_id == self.dormitory_id else None
        return value

    def selection(self, row: CustomTabEntry, column_id: int, source: str) -> str | None:
        selected = (row.fill_selections or {}).get(str(column_id), {})
        return selected.get("record_id") if selected.get("source") == source else None

    def value(
        self, row: Record, column: TableColumn, stack: frozenset[tuple[int, int]] = frozenset()
    ) -> Any:
        if not column.fill or not isinstance(row, CustomTabEntry):
            return record_value(row, column)
        key = (row.id, column.id)
        if key in stack or len(stack) > 40:
            raise HTTPException(409, "Обнаружена круговая связь ячеек")
        stack = stack | {key}
        fill = CellFill.model_validate(column.fill)
        selector = column.id if fill.mode == "pick" else fill.match_column_id
        if selector is None:
            raise HTTPException(409, "Не настроен столбец выбора записи")
        selected = self.selection(row, selector, fill.source)
        if selected is None:
            return None
        if fill.mode == "lookup" and fill.update == "copy":
            copy = (row.fill_copies or {}).get(str(column.id), {})
            if copy.get("signature") == signature(fill) and copy.get("record_id") == selected:
                return copy.get("value")
            raise HTTPException(409, "Копия не создана. Выберите запись заново.")
        value = self.read(fill.source, selected, fill.field, stack)
        # Поля могут очищаться, false и 0 при этом остаются значениями.
        return None if value == "" else value

    def response(self, row: CustomTabEntry) -> TabEntryResponse:
        values: dict[str, Any] = {}
        errors: dict[str, str] = {}
        for column in self.columns.values():
            if column.table_key != f"custom_{row.tab_id}" or column.archived or not column.fill:
                continue
            try:
                values[str(column.id)] = self.value(row, column)
            except HTTPException as exc:
                values[str(column.id)] = None
                errors[str(column.id)] = str(exc.detail)
        return TabEntryResponse.model_validate(row).model_copy(
            update={"fill_values": values, "fill_errors": errors}
        )


def signature(fill: CellFill) -> str:
    return hashlib.sha256(json.dumps(fill.model_dump(), sort_keys=True).encode()).hexdigest()


def source_catalog(db: Session, dormitory_id: int) -> list[dict[str, Any]]:
    from app.table_data import ensure_columns

    dorm = db.get(Dormitory, dormitory_id)
    assert dorm is not None
    for key in DEFAULT_COLUMNS:
        if all(
            section_status(dorm, ancestor) != "deleted" for ancestor in section_ancestors(dorm, key)
        ):
            ensure_columns(db, dormitory_id, key)
    resolver = FillResolver(db, dormitory_id)
    result = [
        {
            "key": "personnel",
            "name": "Персонал / Сотрудники",
            "fields": [
                {"id": key, "name": name, "kind": "text"} for key, name in PERSONNEL_FIELDS.items()
            ],
        }
    ]
    for key in [*DEFAULT_COLUMNS, *resolver.tabs]:
        if not resolver.available(key):
            continue
        fields = [
            {"id": str(col.id), "name": col.name, "kind": resolver.field(key, str(col.id))[1]}
            for col in resolver.columns.values()
            if col.table_key == key and not col.archived and col.kind != "action"
        ]
        if fields:
            result.append(
                {"key": key, "name": SECTIONS.get(key) or resolver.tabs[key].name, "fields": fields}
            )
    return result


def validate_fills(db: Session, dormitory_id: int) -> None:
    resolver = FillResolver(db, dormitory_id)
    bound = {
        value
        for binding in db.scalars(
            select(PersonnelBinding).where(PersonnelBinding.dormitory_id == dormitory_id)
        )
        for value in binding.fields.values()
    }
    graph: dict[int, list[int]] = {}
    for column in resolver.columns.values():
        if column.archived or not column.fill:
            continue
        if (
            not column.table_key.startswith("custom_")
            or column.builtin_key
            or column.kind not in FILL_KINDS
        ):
            raise HTTPException(
                422,
                "Заполнение доступно для пользовательских столбцов: текст, число, дата и чекбокс",
            )
        if column.id in bound:
            raise HTTPException(
                409, f"«{column.name}» уже назначен полю персонала. Сначала измените назначение."
            )
        fill = CellFill.model_validate(column.fill)
        _, kind = resolver.field(fill.source, fill.field)
        if fill.source == column.table_key:
            raise HTTPException(422, "Выберите другую таблицу-источник")
        if kind != column.kind or (fill.mode == "pick" and column.kind != "text"):
            raise HTTPException(
                422, f"Тип значения источника несовместим со столбцом «{column.name}»"
            )
        dependencies = [] if fill.source == "personnel" else [int(fill.field)]
        if fill.mode == "pick":
            if fill.match_column_id is not None or fill.update != "live":
                raise HTTPException(422, "Для выбора записи не нужны сопоставление и режим копии")
        else:
            match = resolver.columns.get(fill.match_column_id or 0)
            if (
                not match
                or match.archived
                or match.table_key != column.table_key
                or not match.fill
                or match.fill.get("mode") != "pick"
                or match.fill.get("source") != fill.source
            ):
                raise HTTPException(
                    422, f"Для «{column.name}» выберите столбец выбора записи из той же таблицы"
                )
            dependencies.append(match.id)
        graph[column.id] = dependencies
    complete: set[int] = set()

    def visit(key: int, path: frozenset[int]) -> None:
        if key in path or len(path) > 40:
            raise HTTPException(422, "Связи столбцов образуют круг или слишком длинную цепочку")
        if key in complete:
            return
        for other in graph.get(key, []):
            visit(other, path | {key})
        complete.add(key)

    for key in graph:
        visit(key, frozenset())


def assign_fill(
    column: TableColumn, fill: CellFill | None, mapping: dict[int, int] | None = None
) -> bool:
    data = fill.model_dump() if fill else None
    if data and mapping:
        if data["match_column_id"] is not None:
            data["match_column_id"] = mapping.get(data["match_column_id"], data["match_column_id"])
        if data["field"].lstrip("-").isdecimal():
            data["field"] = str(mapping.get(int(data["field"]), int(data["field"])))
    changed = column.fill != data
    column.fill = data
    return changed


def capture_copy(resolver: FillResolver, row: CustomTabEntry, column: TableColumn) -> None:
    fill = CellFill.model_validate(column.fill)
    record_id = resolver.selection(row, fill.match_column_id or 0, fill.source)
    copies = dict(row.fill_copies or {})
    if record_id is None:
        copies.pop(str(column.id), None)
    else:
        value = resolver.read(fill.source, record_id, fill.field)
        copies[str(column.id)] = {
            "signature": signature(fill),
            "record_id": record_id,
            "value": value,
        }
    row.fill_copies = copies


def refresh_copies(db: Session, dormitory_id: int, changed: list[TableColumn]) -> None:
    resolver = FillResolver(db, dormitory_id)
    by_table: dict[str, list[TableColumn]] = {}
    for col in changed:
        if not col.table_key.startswith("custom_"):
            continue
        by_table.setdefault(col.table_key, []).append(col)
    for key, columns in by_table.items():
        for row in records_for(db, dormitory_id, key):
            assert isinstance(row, CustomTabEntry)
            for col in columns:
                if (
                    col.fill
                    and col.fill.get("mode") == "lookup"
                    and col.fill.get("update") == "copy"
                ):
                    capture_copy(resolver, row, col)


def checked_fill_changes(db: Session, dormitory_id: int, changed: list[TableColumn]) -> None:
    try:
        validate_fills(db, dormitory_id)
        refresh_copies(db, dormitory_id, changed)
    except HTTPException:
        db.rollback()
        raise


def choose_record(
    db: Session, row: CustomTabEntry, column: TableColumn, record_id: str | None
) -> TabEntryResponse:
    if not column.fill or column.fill.get("mode") != "pick" or column.archived:
        raise HTTPException(409, "Этот столбец не настроен для выбора записи")
    resolver = FillResolver(db, row.dormitory_id)
    fill = CellFill.model_validate(column.fill)
    if record_id is not None:
        resolver.read(fill.source, record_id, fill.field)
    selections = dict(row.fill_selections or {})
    if record_id is None:
        selections.pop(str(column.id), None)
    else:
        selections[str(column.id)] = {"source": fill.source, "record_id": record_id}
    row.fill_selections = selections
    for dependent in resolver.columns.values():
        if (
            dependent.table_key == column.table_key
            and not dependent.archived
            and dependent.fill
            and dependent.fill.get("mode") == "lookup"
            and dependent.fill.get("update") == "copy"
            and dependent.fill.get("match_column_id") == column.id
        ):
            capture_copy(resolver, row, dependent)
    return resolver.response(row)


def fill_dependencies(db: Session, column: TableColumn) -> list[str]:
    return [
        f"Ячейки «{other.name}»"
        for other in db.scalars(
            select(TableColumn).where(
                TableColumn.dormitory_id == column.dormitory_id, TableColumn.archived.is_(False)
            )
        )
        if other.fill
        and (
            (
                other.fill.get("source") == column.table_key
                and other.fill.get("field") == str(column.id)
            )
            or (
                other.table_key == column.table_key
                and other.fill.get("match_column_id") == column.id
            )
        )
    ]


def table_fill_dependencies(db: Session, dormitory_id: int, keys: set[str]) -> list[str]:
    return [
        col.name
        for col in db.scalars(
            select(TableColumn).where(
                TableColumn.dormitory_id == dormitory_id, TableColumn.archived.is_(False)
            )
        )
        if col.fill and col.fill.get("source") in keys and col.table_key not in keys
    ]


def remap_copied_fills(
    db: Session,
    dormitory_id: int,
    mapping: dict[int, int],
    tables: dict[str, str],
    source_dormitory: int | None = None,
    copied_ids: set[int] | None = None,
) -> None:
    """Переназначить структуру без копирования выбранных записей и снимков ячеек."""
    from app.table_data import ensure_columns

    for copied_id in copied_ids if copied_ids is not None else mapping.values():
        column = db.get(TableColumn, copied_id)
        assert column is not None
        if not column.fill:
            continue
        data = dict(column.fill)
        old_source = data["source"]
        data["source"] = tables.get(old_source, old_source)
        if data.get("match_column_id") is not None:
            if data["match_column_id"] not in mapping:
                raise HTTPException(422, "В копии отсутствует столбец выбора записи")
            data["match_column_id"] = mapping[data["match_column_id"]]
        if old_source != "personnel":
            old_field = int(data["field"])
            if old_field in mapping:
                data["field"] = str(mapping[old_field])
            elif source_dormitory == dormitory_id:
                pass
            elif source_dormitory is not None and not old_source.startswith("custom_"):
                original = db.get(TableColumn, old_field)
                candidates = ensure_columns(db, dormitory_id, old_source)
                matches = [
                    item
                    for item in candidates
                    if original
                    and not item.archived
                    and item.kind == original.kind
                    and (
                        (original.builtin_key and item.builtin_key == original.builtin_key)
                        or (
                            not original.builtin_key
                            and item.name.casefold() == original.name.casefold()
                        )
                    )
                ]
                if len(matches) != 1:
                    raise HTTPException(
                        422,
                        "В общежитии-получателе нет совместимого столбца-источника. "
                        "Используйте шаблон полной структуры.",
                    )
                data["field"] = str(matches[0].id)
            else:
                raise HTTPException(
                    422, "Для связанных ячеек включите также таблицу-источник в шаблон структуры."
                )
        column.fill = data
    validate_fills(db, dormitory_id)
