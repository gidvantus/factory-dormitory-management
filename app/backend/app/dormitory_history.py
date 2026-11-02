"""Читаемая история данных: названия вкладок и полей фиксируются вместе с изменением.

Пишется той же транзакцией, что и данные. Настройки, чтение и технический журнал
сюда не входят. Секреты не собираются: разрешены только операционные модели
общежития. Маскирование общего журнала действий остаётся прежним.
"""

import json
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, cast
from zoneinfo import ZoneInfo

from sqlalchemy import event, inspect, select
from sqlalchemy.orm import ORMExecuteState, Session
from sqlalchemy.sql.dml import Delete

from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.dormitory_history import DormitoryDataEvent
from app.models.hostel import Hostel, HostelCell
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.report import ReportCell, ReportRow
from app.models.resident import Resident
from app.models.table_column import ArchiveEntry, TableColumn
from app.section_state import SECTIONS, section_ancestors


@dataclass
class HistoryRequest:
    method: str
    actor_id: int | None = None
    organization_id: int | None = None
    actor_name: str | None = None


request_context: ContextVar[HistoryRequest | None] = ContextVar("dormitory_history", default=None)
ROW_TABLES = {
    Resident: "residents",
    PersonnelInflow: "inflow",
    PersonnelOutflow: "outflow",
    ArchiveEntry: "archive",
}
DATA_MODELS = (*ROW_TABLES, CustomTabEntry, PaymentEntry, ReportCell, HostelCell)
LABELS = {
    "full_name": "ФИО",
    "personnel_number": "Т/н",
    "gender": "Пол",
    "hostel_id": "Хостел",
    "shift_start": "Начало вахты",
    "shift_end": "Конец вахты",
    "shift_count": "Количество смен",
    "phone": "Телефон",
    "medical_book": "Медкнижка",
    "notes": "Примечание",
    "citizenship": "Гражданство",
    "settlement_date": "Дата заселения",
    "departure_date": "Дата выезда",
    "reason": "Причина",
    "additional_info": "Дополнительно",
    "advance_amount": "Сумма аванса",
    "evicted_at": "Выселение",
    "processed_as": "Результат обработки",
    "processed_at": "Дата обработки",
}
PLACE_LABELS = {
    "paid_m": "Оплачено мест — М",
    "paid_f": "Оплачено мест — Ж",
    "residents_m": "Проживает — М",
    "residents_f": "Проживает — Ж",
    "occupied_m": "Проживает — М",
    "occupied_f": "Проживает — Ж",
}


def record_actor(actor_id: int | None, organization_id: int | None, name: str | None) -> None:
    context = request_context.get()
    if context is not None:
        context.actor_id, context.organization_id, context.actor_name = (
            actor_id,
            organization_id,
            name,
        )


def _context() -> HistoryRequest | None:
    context = request_context.get()
    return (
        context
        if context and context.actor_id and context.method in {"POST", "PUT", "PATCH", "DELETE"}
        else None
    )


def _text(value: Any) -> str:
    if value is None or value == "":
        return "пусто"
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    if isinstance(value, datetime):
        moment = value.replace(tzinfo=UTC) if value.tzinfo is None else value
        return moment.astimezone(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M:%S МСК")
    if isinstance(value, date):
        return value.strftime("%d.%m.%Y")
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


def _tab_name(db: Session, dorm: Dormitory, key: str) -> str:
    if not key.startswith("custom_"):
        return " → ".join(
            SECTIONS.get(part, part) for part in reversed(section_ancestors(dorm, key))
        )
    tab = db.get(CustomTab, int(key.removeprefix("custom_")))
    names: list[str] = []
    seen: set[int] = set()
    while tab and tab.id not in seen:
        seen.add(tab.id)
        names.insert(0, tab.name)
        if tab.parent_section:
            names.insert(0, _tab_name(db, dorm, tab.parent_section))
        tab = db.get(CustomTab, tab.parent_id) if tab.parent_id else None
    return " → ".join(names) or "Пользовательская таблица"


def _pair(state: Any, name: str, operation: str) -> tuple[Any, Any]:
    attr = state.attrs[name]
    if operation == "insert":
        return None, attr.value
    if operation == "delete":
        return attr.value, None
    history = attr.history
    return (
        history.deleted[0] if history.deleted else None,
        history.added[0] if history.added else attr.value,
    )


def _value(db: Session, column: TableColumn | None, value: Any) -> str:
    if column and column.kind == "select":
        return next(
            (str(option["label"]) for option in column.options if option["id"] == value),
            _text(value),
        )
    if column and column.kind == "date" and value:
        try:
            return date.fromisoformat(str(value)).strftime("%d.%m.%Y")
        except ValueError:
            pass
    return _text(value)


def _selection(db: Session, column: TableColumn | None, selection: Any) -> str:
    if not selection:
        return "пусто"
    from app.models.personnel import Employee
    from app.table_data import TABLE_MODELS

    source = str(selection.get("source", ""))
    identifier = selection.get("record_id")
    model = (
        Employee
        if source == "personnel"
        else CustomTabEntry
        if source.startswith("custom_")
        else TABLE_MODELS.get(source)
    )
    try:
        row = (
            db.get(model, str(identifier) if source == "personnel" else int(identifier))
            if model
            else None
        )
    except (ValueError, TypeError):
        row = None
    if row is None:
        return f"Запись №{identifier} ({source})"
    label = getattr(row, "full_name", None)
    if not label and column and column.fill:
        label = getattr(row, "custom_values", {}).get(str(column.fill.get("field")))
    return f"{label or 'Запись'} · №{identifier}"


def _add(db: Session, dorm: Dormitory, action: str) -> None:
    context = _context()
    if (
        context is None
        or context.actor_id is None
        or dorm.organization_id != context.organization_id
    ):
        return
    db.add(
        DormitoryDataEvent(
            dormitory_id=dorm.id,
            organization_id=dorm.organization_id,
            actor_id=context.actor_id,
            actor_name=context.actor_name or f"Пользователь №{context.actor_id}",
            action=action,
        )
    )


def _columns(db: Session, dormitory_id: int, key: str) -> list[TableColumn]:
    cache: dict[tuple[int, str], list[TableColumn]] = db.info.setdefault("history_columns", {})
    if (dormitory_id, key) not in cache:
        cache[dormitory_id, key] = list(
            db.scalars(
                select(TableColumn).where(
                    TableColumn.dormitory_id == dormitory_id,
                    TableColumn.table_key == key,
                )
            )
        )
    return cache[dormitory_id, key]


@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
def clear_metadata_cache(session: Session) -> None:
    session.info.pop("history_columns", None)


def capture(db: Session, row: Any, operation: str) -> None:
    if _context() is None:
        return
    state = inspect(row)
    if isinstance(row, ReportCell | HostelCell):
        parent = (
            db.get(ReportRow, row.row_id)
            if isinstance(row, ReportCell)
            else db.get(Hostel, row.hostel_id)
        )
        if parent is None:
            return
        dorm = db.get(Dormitory, parent.dormitory_id)
        if dorm is None:
            return
        title = (
            f"Общий отчёт → строка «{parent.name}»"
            if isinstance(row, ReportCell)
            else f"Размещение персонала → хостел «{parent.name}» → "
            f"{PLACE_LABELS.get(row.field, row.field)}"
        )
        old, new = _pair(state, "value", operation)
        if old != new:
            _add(
                db,
                dorm,
                f"{title} → {row.report_date:%d.%m.%Y}: "
                f"значение изменено с «{_text(old)}» на «{_text(new)}».",
            )
        return
    dorm = db.get(Dormitory, row.dormitory_id)
    if dorm is None:
        return
    key = (
        f"custom_{row.tab_id}"
        if isinstance(row, CustomTabEntry)
        else row.kind
        if isinstance(row, PaymentEntry)
        else ROW_TABLES[type(row)]
    )
    columns = _columns(db, dorm.id, key)
    by_id = {str(column.id): column for column in columns}
    by_builtin = {column.builtin_key: column for column in columns if column.builtin_key}
    full_name = getattr(row, "full_name", None)
    if (
        operation == "update"
        and "full_name" in state.attrs
        and state.attrs.full_name.history.deleted
    ):
        full_name = state.attrs.full_name.history.deleted[0]
    if not full_name:
        name_column = next((column for column in columns if column.name.casefold() == "фио"), None)
        full_name = (
            getattr(row, "custom_values", {}).get(str(name_column.id)) if name_column else None
        )
    caption = f"запись №{row.id}" + (f" «{full_name}»" if full_name else "")
    number = getattr(row, "personnel_number", None)
    if number:
        caption += f", Т/н {number}"
    title = f"{_tab_name(db, dorm, key)} → {caption}"
    if operation == "update" and state.attrs.dormitory_id.history.has_changes():
        before, _ = _pair(state, "dormitory_id", operation)
        source = db.get(Dormitory, before) if before else None
        action = f"{title}: перевод из «{source.name if source else before}» в «{dorm.name}»."
        _add(db, dorm, action)
        if source:
            _add(db, source, action)
        return
    changes = []
    for name in LABELS:
        if name not in state.attrs or (
            operation == "update" and not state.attrs[name].history.has_changes()
        ):
            continue
        old, new = _pair(state, name, operation)
        if old == new or (
            operation != "update" and (old if operation == "delete" else new) in (None, "")
        ):
            continue
        column = by_builtin.get(name)
        if name == "processed_as":
            statuses = {"residents": "Заселён", "outflow": "Направлен в отток"}
            old, new = statuses.get(old, old), statuses.get(new, new)
        if name == "hostel_id":
            old_hostel = db.get(Hostel, old) if old else None
            new_hostel = db.get(Hostel, new) if new else None
            old, new = (
                old_hostel.name if old_hostel else old,
                new_hostel.name if new_hostel else new,
            )
        changes.append(
            f"{column.name if column else LABELS[name]}: «{_text(old)}» → «{_text(new)}»"
        )
    for name in ("custom_values", "calendar_values", "fill_selections"):
        if name not in state.attrs or (
            operation == "update" and not state.attrs[name].history.has_changes()
        ):
            continue
        old, new = _pair(state, name, operation)
        old, new = old or {}, new or {}
        for identifier in sorted(old.keys() | new.keys()):
            if old.get(identifier) == new.get(identifier):
                continue
            column = by_id.get(str(identifier))
            label = column.name if column else f"Столбец №{identifier}"
            if name == "calendar_values":
                label = f"Дата {date.fromisoformat(identifier):%d.%m.%Y}"
            formatter = _selection if name == "fill_selections" else _value
            changes.append(
                f"{label}: «{formatter(db, column, old.get(identifier))}» → "
                f"«{formatter(db, column, new.get(identifier))}»"
            )
    changes = list(dict.fromkeys(changes))
    if operation == "update" and not changes:
        return
    verb = {"insert": "добавлена запись", "update": "изменены данные", "delete": "удалена запись"}[
        operation
    ]
    _add(db, dorm, f"{title}: {verb}." + ("\n" + ";\n".join(changes) if changes else ""))


@event.listens_for(Session, "after_flush")
def capture_flushed(session: Session, _flush_context: Any) -> None:
    if _context() is None:
        return
    for operation, rows in (
        ("insert", list(session.new)),
        ("update", list(session.dirty)),
        ("delete", list(session.deleted)),
    ):
        for row in rows:
            if isinstance(row, DATA_MODELS):
                capture(session, row, operation)


@event.listens_for(Session, "do_orm_execute")
def capture_bulk_delete(state: ORMExecuteState) -> None:
    if _context() is None or not state.is_delete or state.bind_mapper is None:
        return
    model: Any = state.bind_mapper.class_
    if model not in DATA_MODELS:
        return
    query = select(model)
    statement = cast(Delete, state.statement)
    if statement.whereclause is not None:
        query = query.where(statement.whereclause)
    rows: list[Any] = list(state.session.scalars(query))
    for row in rows:
        capture(state.session, row, "delete")
