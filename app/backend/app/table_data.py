"""Общая структура таблиц; идентификаторы столбцов не зависят от их названий."""

from datetime import UTC, date
from decimal import Decimal, InvalidOperation
from typing import Any, cast
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.hostel import Hostel, HostelCell
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.report import ReportRow
from app.models.resident import Resident
from app.models.table_column import ArchiveEntry, TableColumn
from app.place_values import active_in_month, place_day_values
from app.schemas.table_column import (
    ArrivalPlanReportLink,
    PlaceReportLink,
    ReportLink,
    ReportSourceLink,
    report_link_adapter,
)
from app.section_state import locked_dormitory, require_section, require_section_writable

Record = (
    Resident | PersonnelInflow | PersonnelOutflow | PaymentEntry | ArchiveEntry | CustomTabEntry
)
TABLE_MODELS: dict[str, type[Record]] = {
    "residents": Resident,
    "inflow": PersonnelInflow,
    "outflow": PersonnelOutflow,
    "advance": PaymentEntry,
    "settlement": PaymentEntry,
    "archive": ArchiveEntry,
}
# Последовательность совпадает с существующими таблицами. Служебные кнопки также скрываемы.
DEFAULT_COLUMNS: dict[str, list[tuple[str, str, str]]] = {
    "residents": [
        ("row_number", "№", "action"),
        ("gender", "Пол", "select"),
        ("personnel_number", "Т/н", "text"),
        ("full_name", "ФИО", "text"),
        ("hostel_id", "Место проживания", "hostel"),
        ("shift_start", "Начало вахты", "date"),
        ("shift_count", "Кол-во смен", "number"),
        ("shift_end", "Конец вахты", "date"),
        ("phone", "Номер телефона", "text"),
        ("medical_book", "ЛМК", "select"),
        ("notes", "Доп. информация", "text"),
        ("action_advance", "Запись на аванс", "action"),
        ("action_settlement", "Запись на расчёт", "action"),
        ("action_transfer", "Перевод", "action"),
        ("action_outflow", "В отток", "action"),
        ("action_delete", "Удалить", "action"),
    ],
    "inflow": [
        ("settlement_date", "Дата заселения", "date"),
        ("personnel_number", "Т/н", "text"),
        ("full_name", "ФИО", "text"),
        ("citizenship", "Гражданство", "text"),
        ("notes", "Примечание", "text"),
        ("shift_count", "Кол-во смен", "number"),
        ("action_check_in", "Заселить", "action"),
        ("action_outflow", "В отток", "action"),
        ("action_delete", "Удалить", "action"),
    ],
    "outflow": [
        ("departure_date", "Дата выезда", "date"),
        ("personnel_number", "Т/н", "text"),
        ("full_name", "ФИО", "text"),
        ("shift_start", "Начало вахты", "date"),
        ("reason", "Причина", "text"),
        ("notes", "Примечание", "text"),
        ("additional_info", "Доп. информация", "text"),
        ("action_evict", "Выселение", "action"),
        ("action_delete", "Удалить", "action"),
    ],
    "advance": [
        ("personnel_number", "Т/н", "text"),
        ("full_name", "ФИО", "text"),
        ("advance_amount", "Сумма аванса", "number"),
        ("action_delete", "Удалить", "action"),
    ],
    "settlement": [
        ("personnel_number", "Т/н", "text"),
        ("full_name", "ФИО", "text"),
        ("settlement_date", "Дата расчёта", "date"),
        ("action_delete", "Удалить", "action"),
    ],
    "archive": [("action_delete", "Удалить", "action")],
}


def lock_dormitory(db: Session, dormitory_id: int) -> None:
    locked_dormitory(db, dormitory_id)


def get_custom_tab(
    db: Session,
    dormitory_id: int,
    tab_id: int,
    *,
    require_table: bool = False,
    require_active: bool = False,
) -> CustomTab:
    tab = db.scalar(
        select(CustomTab)
        .where(CustomTab.id == tab_id, CustomTab.dormitory_id == dormitory_id)
        .execution_options(populate_existing=True)
    )
    if tab is None:
        raise HTTPException(404, "Вкладка не найдена")
    if require_table and tab.kind == "archive":
        raise HTTPException(
            409, "Архив действий доступен через историю и не является ручной таблицей"
        )
    if require_active and not tab.is_active:
        raise HTTPException(
            409, "Вкладка скрыта и доступна только для просмотра. Сначала восстановите её."
        )
    if require_active and tab.parent_id:
        get_custom_tab(db, dormitory_id, tab.parent_id, require_active=True)
    if require_active and tab.parent_section:
        require_section_writable(db, dormitory_id, tab.parent_section)
    if require_table and not tab.table_created:
        raise HTTPException(409, "Сначала создайте таблицу во вкладке")
    return tab


def require_writable_table(db: Session, dormitory_id: int, table_key: str) -> None:
    if table_key.startswith("custom_"):
        tab = get_custom_tab(
            db, dormitory_id, int(table_key.removeprefix("custom_")), require_active=True
        )
        if tab.kind == "archive":
            raise HTTPException(
                409, "Архив действий заполняется автоматически и доступен только для чтения"
            )
    else:
        require_section_writable(db, dormitory_id, table_key)


def columns_for(db: Session, dormitory_id: int, table_key: str) -> list[TableColumn]:
    return list(
        db.scalars(
            select(TableColumn)
            .where(
                TableColumn.dormitory_id == dormitory_id,
                TableColumn.table_key == table_key,
            )
            .order_by(TableColumn.position, TableColumn.id)
        )
    )


def ensure_columns(db: Session, dormitory_id: int, table_key: str) -> list[TableColumn]:
    lock_dormitory(db, dormitory_id)
    if table_key.startswith("custom_"):
        get_custom_tab(db, dormitory_id, int(table_key.removeprefix("custom_")), require_table=True)
        return columns_for(db, dormitory_id, table_key)
    require_section(db, dormitory_id, table_key)
    columns = columns_for(db, dormitory_id, table_key)
    if columns:
        if table_key == "inflow":
            missing = [
                (key, name)
                for key, name in (("action_check_in", "Заселить"), ("action_outflow", "В отток"))
                if not any(col.builtin_key == key for col in columns)
            ]
            if missing:
                delete = next((col for col in columns if col.builtin_key == "action_delete"), None)
                position = delete.position if delete else max(col.position for col in columns) + 1
                for col in columns:
                    if col.position >= position:
                        col.position += len(missing)
                for offset, (key, name) in enumerate(missing):
                    db.add(
                        TableColumn(
                            dormitory_id=dormitory_id,
                            table_key="inflow",
                            builtin_key=key,
                            name=name,
                            kind="action",
                            position=position + offset,
                            options=[],
                        )
                    )
                db.flush()
                return columns_for(db, dormitory_id, table_key)
        if table_key == "residents" and not any(
            col.builtin_key == "action_settlement" for col in columns
        ):
            advance = next((col for col in columns if col.builtin_key == "action_advance"), None)
            position = advance.position + 1 if advance else max(col.position for col in columns) + 1
            for col in columns:
                if col.position >= position:
                    col.position += 1
            db.add(
                TableColumn(
                    dormitory_id=dormitory_id,
                    table_key=table_key,
                    builtin_key="action_settlement",
                    name="Запись на расчёт",
                    kind="action",
                    position=position,
                    options=[],
                )
            )
            db.flush()
            return columns_for(db, dormitory_id, table_key)
        return columns
    for position, (key, name, kind) in enumerate(DEFAULT_COLUMNS[table_key]):
        options = {"gender": ["М", "Ж"], "medical_book": ["Есть", "Нет", "Делается"]}.get(key, [])
        db.add(
            TableColumn(
                dormitory_id=dormitory_id,
                table_key=table_key,
                builtin_key=key,
                name=name,
                kind=kind,
                position=4 if table_key == "archive" else position,
                options=[{"id": value, "label": value, "archived": False} for value in options],
            )
        )
    if table_key == "archive":
        for position, (name, kind) in enumerate(
            [
                ("ФИО", "text"),
                ("Т/н", "text"),
                ("Дата архива", "date"),
                ("Примечание", "text"),
            ],
            start=0,
        ):
            db.add(
                TableColumn(
                    dormitory_id=dormitory_id,
                    table_key=table_key,
                    name=name,
                    kind=kind,
                    position=position,
                    options=[],
                )
            )
    db.flush()
    return columns_for(db, dormitory_id, table_key)


def get_column(db: Session, dormitory_id: int, table_key: str, column_id: int) -> TableColumn:
    column = db.get(TableColumn, column_id)
    if column is None or column.dormitory_id != dormitory_id or column.table_key != table_key:
        raise HTTPException(404, "Столбец не найден")
    return column


def records_for(db: Session, dormitory_id: int, table_key: str) -> list[Record]:
    model = CustomTabEntry if table_key.startswith("custom_") else TABLE_MODELS[table_key]
    query = select(model).where(model.dormitory_id == dormitory_id)
    if table_key.startswith("custom_"):
        query = query.where(CustomTabEntry.tab_id == int(table_key.removeprefix("custom_")))
    if table_key in ("advance", "settlement"):
        query = query.where(PaymentEntry.kind == table_key)
    return list(db.scalars(query.order_by(model.id)))


def column_type_change_reason(db: Session, column: TableColumn) -> str | None:
    if column.builtin_key:
        return "Тип стандартного столбца связан с работой системы"
    if column.fill:
        return "Сначала отключите связь заполнения ячеек"
    if column_dependencies(db, column):
        return "Столбец используется в формулах, связях или настройках"
    from app.models.personnel import PersonnelBinding

    binding = db.scalar(
        select(PersonnelBinding).where(
            PersonnelBinding.dormitory_id == column.dormitory_id,
            PersonnelBinding.table_key == column.table_key,
        )
    )
    if binding and column.id in binding.fields.values():
        return "Столбец связан с карточкой сотрудника"
    if column.table_key.startswith("custom_"):
        tab = db.get(CustomTab, int(column.table_key.removeprefix("custom_")))
        if tab and tab.options.get("date_column_id") == column.id:
            return "Столбец используется для фильтрации по периоду"
    for row in records_for(db, column.dormitory_id, column.table_key):
        value = row.custom_values.get(str(column.id))
        if value is not None and value != "":
            return "Тип можно изменить только у полностью пустого столбца"
    return None


def require_column_type_change(db: Session, column: TableColumn, kind: str) -> None:
    if kind == column.kind:
        return
    if kind in ("action", "hostel"):
        raise HTTPException(422, "Выберите пользовательский тип данных")
    if reason := column_type_change_reason(db, column):
        raise HTTPException(409, reason)


def get_record(db: Session, dormitory_id: int, table_key: str, row_id: int) -> Record:
    model = CustomTabEntry if table_key.startswith("custom_") else TABLE_MODELS[table_key]
    row = cast(Record | None, db.scalar(select(model).where(model.id == row_id).with_for_update()))
    if (
        row is None
        or row.dormitory_id != dormitory_id
        or (isinstance(row, PaymentEntry) and row.kind != table_key)
        or (isinstance(row, CustomTabEntry) and table_key != f"custom_{row.tab_id}")
    ):
        raise HTTPException(404, "Запись не найдена")
    return row


def normalize_value(column: TableColumn, value: Any, *, allow_archived: bool = False) -> Any:
    if value is None or value == "":
        return None
    if column.kind == "checkbox":
        if not isinstance(value, bool):
            raise HTTPException(422, "Для чекбокса укажите да или нет")
        return value
    if column.kind == "number":
        try:
            if len(str(value)) > 100:
                raise InvalidOperation
            number = Decimal(str(value).replace(",", "."))
            if (
                not number.is_finite()
                or abs(number) > Decimal("1e15")
                or (number != 0 and cast(int, number.as_tuple().exponent) < -12)
            ):
                raise InvalidOperation
            return format(number.normalize(), "f")
        except InvalidOperation as exc:
            raise HTTPException(
                422, "Укажите число до 10¹⁵ по модулю и до 12 знаков после запятой"
            ) from exc
    if not isinstance(value, str) or len(value) > 5000 or "\x00" in value:
        raise HTTPException(422, "Укажите текст не длиннее 5000 символов")
    value = value.strip()
    if not value:
        return None
    if column.kind == "date":
        try:
            if date.fromisoformat(value).isoformat() != value:
                raise ValueError
        except ValueError as exc:
            raise HTTPException(422, "Укажите дату в формате ГГГГ-ММ-ДД") from exc
    elif column.kind == "select":
        if not any(
            option["id"] == value and (allow_archived or not option["archived"])
            for option in column.options
        ):
            raise HTTPException(422, "Выберите существующий вариант списка")
    elif column.kind != "text":
        raise HTTPException(422, "Этот столбец недоступен для связи")
    return value


def record_value(row: Record, column: TableColumn, fill_resolver: Any = None) -> Any:
    if column.fill and isinstance(row, CustomTabEntry):
        from app.cell_fill import FillResolver

        db = object_session(row)
        if db is None:
            raise HTTPException(409, "Не удалось прочитать источник связанной ячейки")
        return (fill_resolver or FillResolver(db, row.dormitory_id)).value(row, column)
    value = (
        getattr(row, column.builtin_key, None)
        if column.builtin_key
        else row.custom_values.get(str(column.id))
    )
    if column.kind == "checkbox" and value is None:
        return False
    if isinstance(value, date):
        return value.isoformat()
    if value is not None and column.kind == "number":
        return format(Decimal(str(value)).normalize(), "f")
    return value


def validate_link(db: Session, dormitory_id: int, link: ReportSourceLink) -> ReportSourceLink:
    if isinstance(link, ArrivalPlanReportLink):
        return link
    if isinstance(link, PlaceReportLink):
        require_section(db, dormitory_id, "places")
        if link.hostel_id is not None:
            hostel = db.get(Hostel, link.hostel_id)
            if hostel is None or hostel.dormitory_id != dormitory_id:
                raise HTTPException(404, "Хостел не найден")
        return link
    if link.table_key.startswith("custom_"):
        get_custom_tab(
            db, dormitory_id, int(link.table_key.removeprefix("custom_")), require_table=True
        )
    column = get_column(db, dormitory_id, link.table_key, link.column_id)
    if column.archived:
        raise HTTPException(422, "Столбец удалён. Восстановите его или измените связь")
    if column.kind not in ("text", "number", "date", "checkbox", "select"):
        raise HTTPException(422, "Этот столбец недоступен для связи")
    value = None
    if link.operator == "equals":
        value = normalize_value(column, link.value, allow_archived=True)
        if value is None:
            raise HTTPException(422, "Выберите значение для подсчёта")
    if link.date_column_id is not None:
        date_column = get_column(db, dormitory_id, link.table_key, link.date_column_id)
        if date_column.archived or date_column.kind != "date":
            raise HTTPException(422, "Выберите действующий столбец с датой")
    return link.model_copy(update={"value": value})


def linked_counts(
    db: Session, dormitory_id: int, link: ReportLink, records: list[Record], start: date, end: date
) -> dict[date, int]:
    validated = validate_link(db, dormitory_id, link)
    assert isinstance(validated, ReportLink)
    link = validated
    column = get_column(db, dormitory_id, link.table_key, link.column_id)
    date_column = (
        get_column(db, dormitory_id, link.table_key, link.date_column_id)
        if link.date_column_id is not None
        else None
    )
    counts: dict[date, int] = {}
    from app.cell_fill import FillResolver

    resolver = (
        FillResolver(db, dormitory_id)
        if column.fill or (date_column and date_column.fill)
        else None
    )
    for row in records:
        source_value = record_value(row, column, resolver)
        if link.operator == "not_empty":
            if source_value is None or (isinstance(source_value, str) and not source_value.strip()):
                continue
        elif source_value != link.value:
            continue
        if date_column:
            value = record_value(row, date_column, resolver)
            if not value:
                continue
            day = date.fromisoformat(value)
        else:
            created = row.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=UTC)
            day = created.astimezone(ZoneInfo("Europe/Moscow")).date()
        if start <= day <= end:
            counts[day] = counts.get(day, 0) + 1
    return counts


def linked_place_values(
    db: Session, dormitory_id: int, link: PlaceReportLink, start: date, end: date
) -> dict[date, int]:
    validate_link(db, dormitory_id, link)
    query = select(Hostel).where(Hostel.dormitory_id == dormitory_id)
    if link.hostel_id is not None:
        query = query.where(Hostel.id == link.hostel_id)
    hostels = {hostel.id: hostel for hostel in db.scalars(query)}
    cells = db.scalars(
        select(HostelCell).where(
            HostelCell.hostel_id.in_(hostels),
            HostelCell.report_date >= start,
            HostelCell.report_date <= end,
        )
    )
    raw: dict[tuple[int, date], dict[str, int]] = {}
    for cell in cells:
        if active_in_month(hostels[cell.hostel_id], cell.report_date.replace(day=1)):
            raw.setdefault((cell.hostel_id, cell.report_date), {})[cell.field] = cell.value
    result: dict[date, int] = {}
    for (_, day), values in raw.items():
        result[day] = result.get(day, 0) + place_day_values(values).get(link.metric, 0)
    return result


def column_dependencies(
    db: Session, column: TableColumn, *, include_fill: bool = True
) -> list[str]:
    from app.cell_fill import fill_dependencies
    from app.personnel_builder_dependencies import builder_dependencies

    return (
        builder_dependencies(
            db,
            column.dormitory_id,
            {f"dorm:{column.dormitory_id}:{column.table_key}"},
            field=str(column.id),
        )
        + (fill_dependencies(db, column) if include_fill else [])
        + [
            row.name
            for row in db.scalars(
                select(ReportRow).where(
                    ReportRow.dormitory_id == column.dormitory_id,
                )
            )
            if row.link and column.id in (row.link.get("column_id"), row.link.get("date_column_id"))
        ]
    )


def snapshot_link(db: Session, row: ReportRow) -> dict[str, Any] | None:
    if not row.link:
        return None
    link = validate_link(db, row.dormitory_id, report_link_adapter.validate_python(row.link))
    if isinstance(link, PlaceReportLink):
        hostel = db.get(Hostel, link.hostel_id) if link.hostel_id is not None else None
        return {
            "rule": link.model_dump(),
            "hostel": {
                "name": hostel.name,
                "active_from_month": hostel.active_from_month.isoformat(),
                "active_until_month": hostel.active_until_month.isoformat()
                if hostel.active_until_month
                else None,
            }
            if hostel
            else None,
        }
    if isinstance(link, ArrivalPlanReportLink):
        return {"rule": link.model_dump()}
    snapshot = snapshot_table(db, row.dormitory_id, link.table_key, link.model_dump())
    visited = {link.table_key}
    pending = [snapshot]
    dependencies: list[dict[str, Any]] = []
    while pending:
        current_snapshot = pending.pop()
        for column in current_snapshot["columns"]:
            fill = column.get("fill")
            if not fill or fill["source"] == "personnel" or fill["source"] in visited:
                continue
            visited.add(fill["source"])
            dependency = snapshot_table(
                db,
                row.dormitory_id,
                fill["source"],
                {
                    "table_key": fill["source"],
                    "column_id": int(fill["field"]),
                    "operator": "not_empty",
                    "value": None,
                    "date_column_id": None,
                },
            )
            dependencies.append(dependency)
            pending.append(dependency)
    if dependencies:
        snapshot["fill_sources"] = dependencies
    return snapshot


def snapshot_table(
    db: Session, dormitory_id: int, table_key: str, rule: dict[str, Any]
) -> dict[str, Any]:
    # Preserve the full source schema, including removed built-ins. Otherwise a custom
    # replacement named "Причина" would collide with the default field in a new dormitory.
    columns = columns_for(db, dormitory_id, table_key)
    snapshot: dict[str, Any] = {
        "rule": rule,
        "columns": [
            {
                "id": col.id,
                "builtin_key": col.builtin_key,
                "name": col.name,
                "kind": col.kind,
                "options": col.options,
                "position": col.position,
                "archived": col.archived,
                "fill": col.fill,
            }
            for col in columns
        ],
    }
    if table_key.startswith("custom_"):
        tab = get_custom_tab(
            db, dormitory_id, int(table_key.removeprefix("custom_")), require_table=True
        )
        snapshot["tab_name"] = tab.name
        parents: list[dict[str, Any]] = []
        current = tab
        while current.parent_id:
            current = get_custom_tab(db, dormitory_id, current.parent_id)
            parents.insert(0, {"id": current.id, "name": current.name})
        snapshot["parent_tabs"] = parents
        snapshot["parent_section"] = current.parent_section
    return snapshot


def restore_link(
    db: Session,
    dormitory_id: int,
    snapshot: dict[str, Any] | None,
    mapped: dict[int, int],
    sources: dict[str, int],
    *,
    remap_fill: bool = True,
) -> dict[str, Any] | None:
    if snapshot is None:
        return None
    rule = dict(snapshot["rule"])
    if rule["table_key"] == "arrival_plan":
        return rule
    if rule["table_key"] == "places":
        if rule.get("hostel_id") is not None:
            key = f"hostel_{rule['hostel_id']}"
            if key not in sources:
                source = snapshot["hostel"]
                hostel = Hostel(
                    dormitory_id=dormitory_id,
                    name=source["name"],
                    active_from_month=date.fromisoformat(source["active_from_month"]),
                    active_until_month=date.fromisoformat(source["active_until_month"])
                    if source["active_until_month"]
                    else None,
                )
                db.add(hostel)
                db.flush()
                sources[key] = hostel.id
            rule["hostel_id"] = sources[key]
        return rule
    if rule["table_key"].startswith("custom_"):
        key = rule["table_key"]
        if key not in sources:
            parent_id = None
            parent_section = snapshot.get("parent_section")
            parents = snapshot.get(
                "parent_tabs", [snapshot["parent_tab"]] if snapshot.get("parent_tab") else []
            )
            for parent in parents:
                parent_key = f"custom_{parent['id']}"
                if parent_key not in sources:
                    group = CustomTab(
                        dormitory_id=dormitory_id,
                        name=parent["name"],
                        is_group=True,
                        parent_id=parent_id,
                        parent_section=parent_section if not parent_id else None,
                    )
                    db.add(group)
                    db.flush()
                    sources[parent_key] = group.id
                parent_id = sources[parent_key]
            tab = CustomTab(
                dormitory_id=dormitory_id,
                name=snapshot["tab_name"],
                table_created=True,
                parent_id=parent_id,
                parent_section=parent_section if not parent_id else None,
            )
            db.add(tab)
            db.flush()
            sources[key] = tab.id
        else:
            existing = db.get(CustomTab, sources[key])
            assert existing is not None
            existing.table_created = True
        rule["table_key"] = f"custom_{sources[key]}"
    columns = columns_for(db, dormitory_id, rule["table_key"])
    previously_mapped = set(mapped)
    for source in snapshot["columns"]:
        if source["id"] in mapped:
            continue
        target = next(
            (
                col
                for col in columns
                if source["builtin_key"] and col.builtin_key == source["builtin_key"]
            ),
            None,
        )
        if target is None:
            target = TableColumn(
                dormitory_id=dormitory_id,
                table_key=rule["table_key"],
                **{key: value for key, value in source.items() if key != "id"},
            )
            db.add(target)
            db.flush()
        else:
            target.name = source["name"]
        mapped[source["id"]] = target.id
    for dependency in snapshot.get("fill_sources", []):
        restore_link(db, dormitory_id, dependency, mapped, sources, remap_fill=False)
    if remap_fill:
        from app.cell_fill import remap_copied_fills

        remap_copied_fills(
            db,
            dormitory_id,
            mapped,
            {key: f"custom_{value}" for key, value in sources.items() if key.startswith("custom_")},
            copied_ids={value for key, value in mapped.items() if key not in previously_mapped},
        )
    rule["column_id"] = mapped[rule["column_id"]]
    if rule.get("date_column_id") is not None:
        rule["date_column_id"] = mapped[rule["date_column_id"]]
    return rule
