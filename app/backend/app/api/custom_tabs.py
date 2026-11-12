"""Вкладки одного общежития с независимым копированием структуры из другого."""

from collections.abc import Callable
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notification_rules
from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser, own_dormitory
from app.api.organization import Membership
from app.api.table_columns import prepare_options
from app.cell_fill import (
    FillResolver,
    assign_fill,
    checked_fill_changes,
    remap_copied_fills,
    table_fill_dependencies,
)
from app.custom_tab_options import initialize_options, mapped_options, options_for
from app.db import get_db
from app.dormitory_arrivals import arrival_rows, source_fields
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.report import ReportRow
from app.models.table_column import TableColumn
from app.personnel import record_changed
from app.personnel_builder_dependencies import builder_dependencies
from app.schemas.custom_tab import (
    CalendarCellRequest,
    CreateTabRequest,
    CreateTabTableRequest,
    TabEntryResponse,
    TabOptions,
    TabResponse,
    TabTemplateResponse,
    UpdateTabRequest,
)
from app.section_state import SECTIONS, require_section_writable, section_parents, section_status
from app.tab_catalog import normalized_name
from app.tab_tree import all_tabs, copy_columns, delete_tabs, descendants
from app.table_data import get_column, get_custom_tab, get_record, lock_dormitory
from app.table_pagination import (
    Paging,
    TablePage,
    display_reader,
    page_items,
    record_page,
    saved_ranks,
)

router = APIRouter(tags=["custom-tabs"], responses={**SUBSCRIBED_USER_RESPONSES})
DbSession = Annotated[Session, Depends(get_db)]
EntityId = Annotated[int, Path(ge=1, le=2147483647)]
TAB_PATH = "/dormitories/{dormitory_id}/tabs"
RESERVED_NAMES = {
    "общий отчет",
    "размещение персонала",
    "проживающие",
    "движение персонала",
    "выплаты",
    "архив",
}


def tab_responses(db: Session, dormitory_id: int, tabs: list[CustomTab]) -> list[TabResponse]:
    # Look across the whole table, without filtering by date or visible columns.
    populated = set(
        db.scalars(
            select(CustomTabEntry.tab_id)
            .where(CustomTabEntry.dormitory_id == dormitory_id)
            .distinct()
        )
    )
    dependencies: dict[str, list[str]] = {}
    for row in db.scalars(select(ReportRow).where(ReportRow.dormitory_id == dormitory_id)):
        if row.link:
            dependencies.setdefault(row.link["table_key"], []).append(row.name)
    tree = all_tabs(db, dormitory_id)
    result = []
    for tab in tabs:
        children = descendants(tree, {tab.id})
        ids = {tab.id, *(child.id for child in children)}
        keys = {tab.table_key, *(child.table_key for child in children)}
        reason = None
        if ids & populated:
            reason = (
                "Во вкладке есть записи. Можно только скрыть её; проверяются записи за всё время."
            )
        elif keys & dependencies.keys():
            reason = (
                "Вкладка используется в строках отчёта: "
                + ", ".join(name for key in keys for name in dependencies.get(key, []))
                + ". Сначала измените их связь или скройте вкладку."
            )
        elif used := table_fill_dependencies(db, dormitory_id, keys):
            reason = "Вкладка используется для заполнения ячеек: " + ", ".join(used)
        elif used := builder_dependencies(
            db, dormitory_id, {f"dorm:{dormitory_id}:{key}" for key in keys}
        ):
            reason = "Вкладка используется в персонале: " + ", ".join(used)
        result.append(
            TabResponse.model_validate(tab).model_copy(
                update={
                    "options": options_for(tab),
                    "has_data": bool(ids & populated),
                    "delete_block_reason": reason,
                }
            )
        )
    return result


@router.get("/custom-tab-templates", response_model=list[TabTemplateResponse])
def list_templates(
    _user: SubscribedUser, membership: Membership, db: DbSession
) -> list[TabTemplateResponse]:
    """Шаблоны вкладок только из общежитий организации из сессии."""
    pairs = list(
        db.execute(
            select(CustomTab, Dormitory)
            .join(Dormitory, Dormitory.id == CustomTab.dormitory_id)
            .where(CustomTab.parent_id.is_(None))
            .where(CustomTab.parent_section.is_(None))
            .where(Dormitory.organization_id == membership.organization_id)
            .order_by(Dormitory.name, CustomTab.name, CustomTab.id)
        )
    )
    metadata: dict[int, TabResponse] = {}
    for dormitory_id in {tab.dormitory_id for tab, _ in pairs}:
        metadata.update(
            {
                tab.id: tab
                for tab in tab_responses(
                    db, dormitory_id, [tab for tab, _ in pairs if tab.dormitory_id == dormitory_id]
                )
            }
        )
    return [
        TabTemplateResponse(
            **metadata[tab.id].model_dump(),
            dormitory_name=dormitory.name,
            client_name=dormitory.client_name,
        )
        for tab, dormitory in pairs
    ]


@router.get(TAB_PATH, response_model=list[TabResponse])
def list_tabs(
    dormitory_id: EntityId, _user: SubscribedUser, db: DbSession, _dormitory: OwnDormitory
) -> list[TabResponse]:
    lock_dormitory(db, dormitory_id)
    tabs = list(
        db.scalars(
            select(CustomTab).where(CustomTab.dormitory_id == dormitory_id).order_by(CustomTab.id)
        )
    )
    return tab_responses(db, dormitory_id, tabs)


@router.patch(TAB_PATH + "/{tab_id}", response_model=TabResponse)
def update_tab(
    dormitory_id: EntityId,
    tab_id: EntityId,
    payload: UpdateTabRequest,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> TabResponse:
    lock_dormitory(db, dormitory_id)
    tab = get_custom_tab(db, dormitory_id, tab_id)
    if payload.is_active and tab.parent_id:
        get_custom_tab(db, dormitory_id, tab.parent_id, require_active=True)
    if payload.is_active and tab.parent_section:
        require_section_writable(db, dormitory_id, tab.parent_section)
    tab.is_active = payload.is_active
    db.commit()
    return tab_responses(db, dormitory_id, [tab])[0]


@router.delete(TAB_PATH + "/{tab_id}", status_code=204)
def delete_tab(
    dormitory_id: EntityId,
    tab_id: EntityId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> None:
    lock_dormitory(db, dormitory_id)
    tab = get_custom_tab(db, dormitory_id, tab_id)
    if reason := tab_responses(db, dormitory_id, [tab])[0].delete_block_reason:
        raise HTTPException(409, reason)
    delete_tabs(db, descendants(all_tabs(db, dormitory_id), {tab.id}))
    db.commit()


@router.post(TAB_PATH, response_model=TabResponse, status_code=201)
def create_tab(
    dormitory_id: EntityId,
    payload: CreateTabRequest,
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> CustomTab:
    source = db.get(CustomTab, payload.source_tab_id) if payload.source_tab_id else None
    if payload.source_tab_id is not None and source is None:
        raise HTTPException(404, "Вкладка для шаблона не найдена")
    if source is not None:
        # Образец приходит телом (`source_tab_id`), а не путём, поэтому гейт
        # маршрута его не закрывает: копировать можно только свою вкладку.
        own_dormitory(db, source.dormitory_id, membership)
        # Lock both schemas in the same order, including copies in opposite directions.
    for identifier in sorted({dormitory_id, source.dormitory_id if source else dormitory_id}):
        lock_dormitory(db, identifier)
    if source:
        source = get_custom_tab(db, source.dormitory_id, source.id)
    if payload.parent_id and payload.parent_section:
        raise HTTPException(422, "Выберите одного родителя вкладки")
    source_tree = descendants(all_tabs(db, source.dormitory_id), {source.id}) if source else []
    parent = None
    if payload.parent_id:
        parent = get_custom_tab(db, dormitory_id, payload.parent_id, require_active=True)
        if parent.kind == "archive":
            raise HTTPException(409, "Архив действий не может содержать подвкладки")
    if payload.kind == "archive" and (payload.subtabs or source):
        raise HTTPException(422, "Для архива выберите новую отдельную подвкладку")
    if payload.parent_section:
        if payload.parent_section not in SECTIONS:
            raise HTTPException(422, "Неизвестная родительская вкладка")
        require_section_writable(db, dormitory_id, payload.parent_section)
    if payload.source_tab_id and payload.subtabs:
        raise HTTPException(422, "Выберите шаблон или создайте собственные подвкладки")
    name_key = normalized_name(payload.name)
    dorm = db.get(Dormitory, dormitory_id)
    assert dorm is not None
    builtin_names = {
        normalized_name(name)
        for key, name in SECTIONS.items()
        if section_parents(dorm).get(key) == payload.parent_section
        and not payload.parent_id
        and section_status(dorm, key) != "deleted"
    }
    names = list(
        db.scalars(
            select(CustomTab.name).where(
                CustomTab.dormitory_id == dormitory_id,
                CustomTab.parent_id == payload.parent_id,
                CustomTab.parent_section == payload.parent_section,
            )
        )
    )
    if (
        name_key in builtin_names
        or (not payload.parent_id and not payload.parent_section and name_key in RESERVED_NAMES)
        or any(normalized_name(name) == name_key for name in names)
    ):
        raise HTTPException(409, "Вкладка с таким названием уже есть")
    if parent:
        parent.is_group = True
    tab = CustomTab(
        dormitory_id=dormitory_id,
        name=payload.name,
        kind=source.kind if source else payload.kind,
        parent_id=payload.parent_id,
        parent_section=payload.parent_section,
        is_group=source.is_group if source else bool(payload.subtabs),
        table_created=source.table_created if source else False,
    )
    db.add(tab)
    db.flush()

    copied_columns: dict[int, int] = {}
    if source and source.table_created:
        mapping = copy_columns(
            db, source.dormitory_id, source.table_key, dormitory_id, tab.table_key
        )
        tab.options = mapped_options(source, mapping)
        copied_columns.update(mapping)
    if source:
        if not source.table_created:
            tab.options = options_for(source).model_dump()
        copied_ids = {source.id: tab.id}
        for child in source_tree:
            if child.id == source.id:
                continue
            copied = CustomTab(
                dormitory_id=dormitory_id,
                parent_id=copied_ids[child.parent_id] if child.parent_id else None,
                is_group=child.is_group,
                name=child.name,
                kind=child.kind,
                table_created=child.table_created,
            )
            db.add(copied)
            db.flush()
            copied_ids[child.id] = copied.id
            mapping = copy_columns(
                db, child.dormitory_id, child.table_key, dormitory_id, copied.table_key
            )
            copied.options = mapped_options(child, mapping)
            copied_columns.update(mapping)
        remap_copied_fills(
            db,
            dormitory_id,
            copied_columns,
            {f"custom_{old}": f"custom_{new}" for old, new in copied_ids.items()},
            source.dormitory_id,
        )
    else:
        for name in payload.subtabs:
            child = CustomTab(dormitory_id=dormitory_id, parent_id=tab.id, name=name)
            db.add(child)
            db.flush()
            if payload.options:
                initialize_options(db, child, payload.options)
        if payload.options or tab.kind == "archive":
            initialize_options(db, tab, payload.options or TabOptions())
    db.commit()
    db.refresh(tab)
    return tab


@router.post(TAB_PATH + "/{tab_id}/table", response_model=TabResponse, status_code=201)
def create_table(
    dormitory_id: EntityId,
    tab_id: EntityId,
    payload: CreateTabTableRequest,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> CustomTab:
    lock_dormitory(db, dormitory_id)
    tab = get_custom_tab(db, dormitory_id, tab_id, require_active=True)
    if tab.table_created:
        raise HTTPException(409, "Таблица уже создана")
    columns: list[TableColumn] = []
    names = {"удалить"}
    for position, column in enumerate(payload.columns):
        if column.kind in ("action", "hostel"):
            raise HTTPException(422, "Выберите тип данных нового столбца")
        if column.name.casefold() in names:
            raise HTTPException(409, "Столбец с таким названием уже есть")
        names.add(column.name.casefold())
        columns.append(
            TableColumn(
                dormitory_id=dormitory_id,
                table_key=tab.table_key,
                name=column.name,
                kind=column.kind,
                position=position,
                options=prepare_options(column, None),
                archived=False,
            )
        )
    columns.append(
        TableColumn(
            dormitory_id=dormitory_id,
            table_key=tab.table_key,
            builtin_key="action_delete",
            name="Удалить",
            kind="action",
            position=len(columns),
            options=[],
            archived=False,
        )
    )
    db.add_all(columns)
    tab.table_created = True
    db.flush()
    client_ids = [item.client_id for item in payload.columns if item.client_id is not None]
    if len(set(client_ids)) != len(client_ids):
        raise HTTPException(422, "Временные идентификаторы столбцов повторяются")
    mapping = {
        item.client_id: column.id
        for item, column in zip(payload.columns, columns, strict=False)
        if item.client_id is not None
    }
    for item, stored_column in zip(payload.columns, columns, strict=False):
        assign_fill(stored_column, item.fill, mapping)
    checked_fill_changes(db, dormitory_id, [])
    db.commit()
    db.refresh(tab)
    return tab


@router.get("/dormitories/{dormitory_id}/arrival-fields")
def arrival_source_fields(
    dormitory_id: EntityId, _user: SubscribedUser, db: DbSession, dormitory: OwnDormitory
) -> list[dict[str, str]]:
    return source_fields(db, dormitory.organization_id)


@router.get(TAB_PATH + "/{tab_id}/arrival-rows")
def list_arrival_rows(
    dormitory_id: EntityId,
    tab_id: EntityId,
    _user: SubscribedUser,
    db: DbSession,
    dormitory: OwnDormitory,
    paging: Paging,
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
) -> list[dict[str, Any]] | dict[str, Any]:
    tab = get_custom_tab(db, dormitory_id, tab_id, require_table=True)
    options = options_for(tab)
    if options.data_source != "arrival_plan":
        raise HTTPException(409, "Во вкладке не включена связь с планом заездов")
    validate_period(from_date, to_date)
    rows = arrival_rows(db, dormitory_id, options.arrival_columns, from_date, to_date)
    if paging.page is None:
        return rows
    sort_key = paging.sort_column
    if sort_key and sort_key not in options.arrival_columns:
        raise HTTPException(422, "Этот столбец недоступен для сортировки")
    result = page_items(
        rows,
        paging,
        ranks=saved_ranks(db, dormitory, tab.table_key),
        row_key=lambda row: row["id"],
        search=lambda row: row["custom_values"].values(),
        order=(lambda row: row["custom_values"].get(sort_key)) if sort_key else None,
    )
    return {"rows": result.rows, "total": result.total, "page": result.page}


@router.get(
    TAB_PATH + "/{tab_id}/rows", response_model=list[TabEntryResponse] | TablePage[TabEntryResponse]
)
def list_rows(
    dormitory_id: EntityId,
    tab_id: EntityId,
    _user: SubscribedUser,
    db: DbSession,
    dormitory: OwnDormitory,
    paging: Paging,
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
) -> list[TabEntryResponse] | TablePage[TabEntryResponse]:
    tab = get_custom_tab(db, dormitory_id, tab_id, require_table=True)
    validate_period(from_date, to_date)
    query = (
        select(CustomTabEntry)
        .where(
            CustomTabEntry.dormitory_id == dormitory_id,
            CustomTabEntry.tab_id == tab_id,
        )
        .order_by(CustomTabEntry.id)
    )
    resolver = FillResolver(db, dormitory_id)
    options = options_for(tab)
    period_filter: Callable[[CustomTabEntry], bool] | None = None
    if from_date and to_date and options.table_format == "list" and options.period_mode != "none":
        if options.date_column_id is None:
            raise HTTPException(409, "Выберите столбец даты в настройках вкладки")
        column = get_column(db, dormitory_id, tab.table_key, options.date_column_id)
        start, end = from_date.isoformat(), to_date.isoformat()
        if column.fill:
            date_value = display_reader(db, column, resolver)

            def within_period(row: CustomTabEntry) -> bool:
                value = None if column.archived else date_value(row)
                return isinstance(value, str) and start <= value <= end

            period_filter = within_period
        else:
            query = query.where(
                CustomTabEntry.custom_values[str(column.id)].as_string().between(start, end)
            )
    if paging.page is None:
        return [
            resolver.response(row)
            for row in db.scalars(query)
            if not period_filter or period_filter(row)
        ]

    return record_page(
        db,
        dormitory,
        tab.table_key,
        query,
        paging,
        predicate=period_filter,
        resolver=resolver,
    ).response(resolver.response)


def validate_period(start: date | None, end: date | None) -> None:
    if (start is None) != (end is None) or (
        start and end and (end < start or (end - start).days > 365)
    ):
        raise HTTPException(422, "Укажите период от 1 до 366 дней")


@router.post(TAB_PATH + "/{tab_id}/rows", response_model=TabEntryResponse, status_code=201)
def create_row(
    dormitory_id: EntityId,
    tab_id: EntityId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
    entry_date: date | None = None,
) -> CustomTabEntry:
    lock_dormitory(db, dormitory_id)
    tab = get_custom_tab(db, dormitory_id, tab_id, require_table=True, require_active=True)
    if not options_for(tab).add_row:
        raise HTTPException(409, "Добавление строк отключено в настройках вкладки")
    options = options_for(tab)
    row = CustomTabEntry(dormitory_id=dormitory_id, tab_id=tab_id)
    if (
        entry_date
        and options.table_format == "list"
        and options.period_mode != "none"
        and options.date_column_id
    ):
        row.custom_values = {str(options.date_column_id): entry_date.isoformat()}
    db.add(row)
    db.commit()
    db.refresh(row)
    # Строка уже сохранена: правила уведомлений ставятся после коммита, поэтому
    # их падение не откатывает добавление и не превращает 201 в 500.
    notification_rules.notify_row_written(
        db,
        dormitory_id=dormitory_id,
        table_key=tab.table_key,
        row_id=row.id,
        actor_id=_user.id,
    )
    return row


@router.delete(TAB_PATH + "/{tab_id}/rows/{row_id}", status_code=204)
def delete_row(
    dormitory_id: EntityId,
    tab_id: EntityId,
    row_id: EntityId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> None:
    lock_dormitory(db, dormitory_id)
    tab = get_custom_tab(db, dormitory_id, tab_id, require_table=True, require_active=True)
    if not options_for(tab).row_actions:
        raise HTTPException(409, "Действия со строками отключены в настройках вкладки")
    row = get_record(db, dormitory_id, tab.table_key, row_id)
    assert isinstance(row, CustomTabEntry)
    if used := builder_dependencies(
        db, dormitory_id, {f"dorm:{dormitory_id}:{tab.table_key}"}, row_id=str(row_id)
    ):
        raise HTTPException(409, "Строка используется в персонале: " + ", ".join(used))
    record_changed(
        db, row, _user.id, kind="deleted", title="Удалена исходная запись пользовательской таблицы"
    )
    db.delete(row)
    db.commit()


@router.post(TAB_PATH + "/{tab_id}/clear")
def clear_rows(
    dormitory_id: EntityId,
    tab_id: EntityId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> dict[str, int]:
    lock_dormitory(db, dormitory_id)
    tab = get_custom_tab(db, dormitory_id, tab_id, require_table=True, require_active=True)
    if not options_for(tab).clear_list:
        raise HTTPException(409, "Очистка списка отключена в настройках вкладки")
    if options_for(tab).table_format == "calendar" and (
        used := builder_dependencies(db, dormitory_id, {f"dorm:{dormitory_id}:{tab.table_key}"})
    ):
        raise HTTPException(409, "Строки используются в персонале: " + ", ".join(used))
    rows = list(
        db.scalars(
            select(CustomTabEntry).where(
                CustomTabEntry.dormitory_id == dormitory_id, CustomTabEntry.tab_id == tab_id
            )
        )
    )
    for row in rows:
        record_changed(db, row, _user.id, kind="deleted", title="Очищена пользовательская таблица")
        db.delete(row)
    db.commit()
    return {"deleted": len(rows)}


@router.put(TAB_PATH + "/{tab_id}/rows/{row_id}/days/{day}")
def update_calendar_cell(
    dormitory_id: EntityId,
    tab_id: EntityId,
    row_id: EntityId,
    day: date,
    payload: CalendarCellRequest,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> dict[str, str]:
    lock_dormitory(db, dormitory_id)
    tab = get_custom_tab(db, dormitory_id, tab_id, require_table=True, require_active=True)
    if options_for(tab).table_format != "calendar":
        raise HTTPException(409, "Включите формат с датами в столбцах")
    row = get_record(db, dormitory_id, tab.table_key, row_id)
    assert isinstance(row, CustomTabEntry)
    values = dict(row.calendar_values)
    value = payload.value.strip()
    if value:
        values[day.isoformat()] = value
    else:
        values.pop(day.isoformat(), None)
    row.calendar_values = values
    db.commit()
    return {"value": value}
