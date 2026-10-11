"""Вкладки одного общежития с независимым копированием структуры из другого."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.table_columns import prepare_options
from app.db import get_db
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.report import ReportRow
from app.models.table_column import TableColumn
from app.personnel import record_changed
from app.schemas.custom_tab import (
    CreateTabRequest,
    CreateTabTableRequest,
    TabEntryResponse,
    TabResponse,
    TabTemplateResponse,
    UpdateTabRequest,
)
from app.section_state import SECTIONS, require_section_writable, section_parents, section_status
from app.security import ACTIVE_USER_RESPONSES, ActiveUser
from app.tab_catalog import normalized_name
from app.tab_tree import all_tabs, copy_columns, delete_tabs, descendants
from app.table_data import get_custom_tab, get_record, lock_dormitory

router = APIRouter(tags=["custom-tabs"], responses={**ACTIVE_USER_RESPONSES})
DbSession = Annotated[Session, Depends(get_db)]
EntityId = Annotated[int, Path(ge=1, le=2147483647)]
TAB_PATH = "/dormitories/{dormitory_id}/tabs"
RESERVED_NAMES = {"большой отчет", "места", "проживающие", "движение персонала", "выплаты", "архив"}


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
        result.append(
            TabResponse.model_validate(tab).model_copy(
                update={"has_data": bool(ids & populated), "delete_block_reason": reason}
            )
        )
    return result


@router.get("/custom-tab-templates", response_model=list[TabTemplateResponse])
def list_templates(_user: ActiveUser, db: DbSession) -> list[TabTemplateResponse]:
    pairs = list(
        db.execute(
            select(CustomTab, Dormitory)
            .join(Dormitory, Dormitory.id == CustomTab.dormitory_id)
            .where(CustomTab.parent_id.is_(None))
            .where(CustomTab.parent_section.is_(None))
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
def list_tabs(dormitory_id: EntityId, _user: ActiveUser, db: DbSession) -> list[TabResponse]:
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
    _user: ActiveUser,
    db: DbSession,
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
def delete_tab(dormitory_id: EntityId, tab_id: EntityId, _user: ActiveUser, db: DbSession) -> None:
    lock_dormitory(db, dormitory_id)
    tab = get_custom_tab(db, dormitory_id, tab_id)
    if reason := tab_responses(db, dormitory_id, [tab])[0].delete_block_reason:
        raise HTTPException(409, reason)
    delete_tabs(db, descendants(all_tabs(db, dormitory_id), {tab.id}))
    db.commit()


@router.post(TAB_PATH, response_model=TabResponse, status_code=201)
def create_tab(
    dormitory_id: EntityId, payload: CreateTabRequest, _user: ActiveUser, db: DbSession
) -> CustomTab:
    source = db.get(CustomTab, payload.source_tab_id) if payload.source_tab_id else None
    if payload.source_tab_id is not None and source is None:
        raise HTTPException(404, "Вкладка для шаблона не найдена")
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
    names = db.scalars(
        select(CustomTab.name).where(
            CustomTab.dormitory_id == dormitory_id,
            CustomTab.parent_id == payload.parent_id,
            CustomTab.parent_section == payload.parent_section,
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
        parent_id=payload.parent_id,
        parent_section=payload.parent_section,
        is_group=source.is_group if source else bool(payload.subtabs),
        table_created=source.table_created if source else False,
    )
    db.add(tab)
    db.flush()

    if source and source.table_created:
        copy_columns(db, source.dormitory_id, source.table_key, dormitory_id, tab.table_key)
    if source:
        copied_ids = {source.id: tab.id}
        for child in source_tree:
            if child.id == source.id:
                continue
            copied = CustomTab(
                dormitory_id=dormitory_id,
                parent_id=copied_ids[child.parent_id] if child.parent_id else None,
                is_group=child.is_group,
                name=child.name,
                table_created=child.table_created,
            )
            db.add(copied)
            db.flush()
            copied_ids[child.id] = copied.id
            copy_columns(db, child.dormitory_id, child.table_key, dormitory_id, copied.table_key)
    else:
        for name in payload.subtabs:
            db.add(CustomTab(dormitory_id=dormitory_id, parent_id=tab.id, name=name))
    db.commit()
    db.refresh(tab)
    return tab


@router.post(TAB_PATH + "/{tab_id}/table", response_model=TabResponse, status_code=201)
def create_table(
    dormitory_id: EntityId,
    tab_id: EntityId,
    payload: CreateTabTableRequest,
    _user: ActiveUser,
    db: DbSession,
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
    db.commit()
    db.refresh(tab)
    return tab


@router.get(TAB_PATH + "/{tab_id}/rows", response_model=list[TabEntryResponse])
def list_rows(
    dormitory_id: EntityId, tab_id: EntityId, _user: ActiveUser, db: DbSession
) -> list[CustomTabEntry]:
    lock_dormitory(db, dormitory_id)
    get_custom_tab(db, dormitory_id, tab_id, require_table=True)
    return list(
        db.scalars(
            select(CustomTabEntry)
            .where(
                CustomTabEntry.dormitory_id == dormitory_id,
                CustomTabEntry.tab_id == tab_id,
            )
            .order_by(CustomTabEntry.id)
        )
    )


@router.post(TAB_PATH + "/{tab_id}/rows", response_model=TabEntryResponse, status_code=201)
def create_row(
    dormitory_id: EntityId, tab_id: EntityId, _user: ActiveUser, db: DbSession
) -> CustomTabEntry:
    lock_dormitory(db, dormitory_id)
    get_custom_tab(db, dormitory_id, tab_id, require_table=True, require_active=True)
    row = CustomTabEntry(dormitory_id=dormitory_id, tab_id=tab_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.delete(TAB_PATH + "/{tab_id}/rows/{row_id}", status_code=204)
def delete_row(
    dormitory_id: EntityId, tab_id: EntityId, row_id: EntityId, _user: ActiveUser, db: DbSession
) -> None:
    lock_dormitory(db, dormitory_id)
    tab = get_custom_tab(db, dormitory_id, tab_id, require_table=True, require_active=True)
    row = get_record(db, dormitory_id, tab.table_key, row_id)
    assert isinstance(row, CustomTabEntry)
    record_changed(
        db, row, _user.id, kind="deleted", title="Удалена исходная запись пользовательской таблицы"
    )
    db.delete(row)
    db.commit()
