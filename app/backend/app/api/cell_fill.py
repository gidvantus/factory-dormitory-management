"""Каталог источников и явный выбор записи в связанной ячейке."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser
from app.cell_fill import FillResolver, choose_record, source_catalog
from app.db import get_db
from app.models.custom_tab import CustomTabEntry
from app.schemas.custom_tab import TabEntryResponse
from app.schemas.table_column import CellSelectionRequest, TableKey
from app.table_data import (
    get_column,
    get_custom_tab,
    get_record,
    lock_dormitory,
    require_writable_table,
)

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/cell-fill",
    tags=["cell-fill"],
    responses=SUBSCRIBED_USER_RESPONSES,
)
DbSession = Annotated[Session, Depends(get_db)]
EntityId = Annotated[int, Path(ge=1, le=2147483647)]


@router.get("/sources")
def sources(
    dormitory_id: EntityId, _user: SubscribedUser, db: DbSession, _dormitory: OwnDormitory
) -> list[dict[str, Any]]:
    result = source_catalog(db, dormitory_id)
    db.commit()
    return result


@router.get("/records")
def records(
    dormitory_id: EntityId,
    source: Annotated[str, Query(min_length=1, max_length=32)],
    field: Annotated[str, Query(min_length=1, max_length=64)],
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
    search: Annotated[str, Query(max_length=200)] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict[str, Any]:
    resolver = FillResolver(db, dormitory_id)
    resolver.field(source, field)
    found = []
    query = search.strip().casefold()
    for record_id, record in resolver.source_records(source).items():
        try:
            label = str(resolver.read(source, record_id, field) or "Не заполнено")
        except HTTPException:
            continue
        if source == "personnel":
            number = record.get("personnel_number")
        else:
            number = getattr(record, "personnel_number", None)
        detail = f"Т/н {number} · Запись №{record_id}" if number else f"Запись №{record_id}"
        if query and query not in f"{label} {detail}".casefold():
            continue
        found.append({"id": record_id, "label": label, "detail": detail})
    found.sort(key=lambda item: (item["label"].casefold(), item["id"]))
    return {"records": found[:limit], "has_more": len(found) > limit}


@router.put("/{table_key}/rows/{row_id}/selection/{column_id}", response_model=TabEntryResponse)
def select_record(
    dormitory_id: EntityId,
    table_key: TableKey,
    row_id: EntityId,
    column_id: EntityId,
    payload: CellSelectionRequest,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> TabEntryResponse:
    lock_dormitory(db, dormitory_id)
    require_writable_table(db, dormitory_id, table_key, data=True)
    row = get_record(db, dormitory_id, table_key, row_id)
    if not isinstance(row, CustomTabEntry):
        raise HTTPException(422, "Выбор записи доступен в пользовательских таблицах")
    column = get_column(db, dormitory_id, table_key, column_id)
    try:
        result = choose_record(db, row, column, payload.record_id)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    return result


@router.get("/{table_key}/values", response_model=list[TabEntryResponse])
def values(
    dormitory_id: EntityId,
    table_key: TableKey,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
    row_ids: Annotated[str | None, Query(pattern=r"^[0-9]{1,10}(?:,[0-9]{1,10}){0,99}$")] = None,
) -> list[TabEntryResponse]:
    if not table_key.startswith("custom_"):
        raise HTTPException(422, "Связанные ячейки доступны в пользовательских таблицах")
    tab = get_custom_tab(db, dormitory_id, int(table_key[7:]), require_table=True)
    resolver = FillResolver(db, dormitory_id)
    query = select(CustomTabEntry).where(
        CustomTabEntry.dormitory_id == dormitory_id, CustomTabEntry.tab_id == tab.id
    )
    if row_ids:
        query = query.where(
            CustomTabEntry.id.in_([int(identifier) for identifier in row_ids.split(",")])
        )
    return [resolver.response(row) for row in db.scalars(query.order_by(CustomTabEntry.id))]
