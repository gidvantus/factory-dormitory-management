"""Настройки столбцов, типизированные дополнительные ячейки и записи архива."""

from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated, Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.table_column import ArchiveEntry, TableColumn
from app.schemas.table_column import CellRequest, ColumnRequest, ColumnResponse, TableKey
from app.security import CurrentUser
from app.table_data import (
    column_dependencies,
    ensure_columns,
    get_column,
    get_record,
    lock_dormitory,
    normalize_value,
)

router = APIRouter(prefix="/dormitories/{dormitory_id}/tables", tags=["table-columns"])
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
ColumnId = Annotated[int, Path(ge=1, le=2147483647)]


def prepare_options(payload: ColumnRequest, existing: TableColumn | None) -> list[dict[str, Any]]:
    old = {item["id"]: item for item in existing.options} if existing else {}
    if payload.kind != "select":
        if payload.options:
            raise HTTPException(422, "Варианты доступны только для выпадающего списка")
        return []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in payload.options:
        if item.id is not None and item.id not in old:
            raise HTTPException(422, "Неизвестный идентификатор варианта")
        option_id = item.id or str(uuid4())
        if option_id in seen:
            raise HTTPException(422, "Вариант указан дважды")
        seen.add(option_id)
        result.append({**item.model_dump(), "id": option_id})
    result.extend({**item, "archived": True} for key, item in old.items() if key not in seen)
    labels = [item["label"].casefold() for item in result if not item["archived"]]
    if not labels or len(labels) != len(set(labels)) or len(result) > 200:
        raise HTTPException(422, "Укажите от 1 до 200 вариантов без повторяющихся названий")
    return result


def check_name(columns: list[TableColumn], name: str, column_id: int | None = None) -> None:
    if any(
        col.id != column_id and not col.archived and col.name.casefold() == name.casefold()
        for col in columns
    ):
        raise HTTPException(409, "Столбец с таким названием уже есть")


@router.get("/{table_key}/columns", response_model=list[ColumnResponse])
def list_columns(
    dormitory_id: DormitoryId, table_key: TableKey, _user: CurrentUser, db: DbSession
) -> list[TableColumn]:
    columns = ensure_columns(db, dormitory_id, table_key)
    db.commit()
    return columns


@router.post("/{table_key}/columns", response_model=ColumnResponse, status_code=201)
def create_column(
    dormitory_id: DormitoryId,
    table_key: TableKey,
    payload: ColumnRequest,
    _user: CurrentUser,
    db: DbSession,
) -> TableColumn:
    columns = ensure_columns(db, dormitory_id, table_key)
    if payload.kind in ("action", "hostel"):
        raise HTTPException(422, "Выберите тип данных нового столбца")
    check_name(columns, payload.name)
    position = min(
        (
            col.position
            for col in columns
            if col.builtin_key and col.builtin_key.startswith("action_")
        ),
        default=max((col.position for col in columns), default=-1) + 1,
    )
    for col in columns:
        if col.position >= position:
            col.position += 1
    column = TableColumn(
        dormitory_id=dormitory_id,
        table_key=table_key,
        name=payload.name,
        kind=payload.kind,
        position=position,
        options=prepare_options(payload, None),
    )
    db.add(column)
    db.commit()
    db.refresh(column)
    return column


@router.patch("/{table_key}/columns/{column_id}", response_model=ColumnResponse)
def update_column(
    dormitory_id: DormitoryId,
    table_key: TableKey,
    column_id: ColumnId,
    payload: ColumnRequest,
    _user: CurrentUser,
    db: DbSession,
) -> TableColumn:
    columns = ensure_columns(db, dormitory_id, table_key)
    column = get_column(db, dormitory_id, table_key, column_id)
    if column.archived:
        raise HTTPException(409, "Сначала восстановите столбец")
    check_name(columns, payload.name, column.id)
    if payload.kind != column.kind:
        raise HTTPException(
            409, "Тип существующего столбца нельзя изменить; создайте новый столбец"
        )
    if column.builtin_key:
        if [item.model_dump() for item in payload.options] != column.options:
            raise HTTPException(409, "Варианты стандартного столбца изменять нельзя")
    else:
        column.options = prepare_options(payload, column)
    column.name = payload.name
    db.commit()
    db.refresh(column)
    return column


@router.delete("/{table_key}/columns/{column_id}", status_code=204)
def delete_column(
    dormitory_id: DormitoryId,
    table_key: TableKey,
    column_id: ColumnId,
    _user: CurrentUser,
    db: DbSession,
) -> None:
    lock_dormitory(db, dormitory_id)
    column = get_column(db, dormitory_id, table_key, column_id)
    if names := column_dependencies(db, column):
        raise HTTPException(
            409,
            "Столбец используется в строках отчёта: "
            + ", ".join(names)
            + ". Сначала измените их связь.",
        )
    column.archived = True
    db.commit()


@router.post("/{table_key}/columns/{column_id}/restore", response_model=ColumnResponse)
def restore_column(
    dormitory_id: DormitoryId,
    table_key: TableKey,
    column_id: ColumnId,
    _user: CurrentUser,
    db: DbSession,
) -> TableColumn:
    columns = ensure_columns(db, dormitory_id, table_key)
    column = get_column(db, dormitory_id, table_key, column_id)
    check_name(columns, column.name, column.id)
    column.archived = False
    db.commit()
    db.refresh(column)
    return column


@router.put("/{table_key}/rows/{row_id}/cells/{column_id}", response_model=CellRequest)
def save_custom_cell(
    dormitory_id: DormitoryId,
    table_key: TableKey,
    row_id: ColumnId,
    column_id: ColumnId,
    payload: CellRequest,
    _user: CurrentUser,
    db: DbSession,
) -> CellRequest:
    lock_dormitory(db, dormitory_id)
    column = get_column(db, dormitory_id, table_key, column_id)
    if column.archived or column.builtin_key:
        raise HTTPException(409, "Этот столбец недоступен для записи")
    row = get_record(db, dormitory_id, table_key, row_id)
    old = row.custom_values.get(str(column.id))
    value = normalize_value(column, payload.value, allow_archived=old == payload.value)
    row.custom_values = {**row.custom_values, str(column.id): value}
    db.commit()
    return CellRequest(value=value)


class ArchiveResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    custom_values: dict[str, Any]


@router.get("/archive/rows", response_model=list[ArchiveResponse])
def list_archive(
    dormitory_id: DormitoryId,
    _user: CurrentUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
) -> list[ArchiveEntry]:
    lock_dormitory(db, dormitory_id)
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(422, "Выберите период не длиннее года")
    zone = ZoneInfo("Europe/Moscow")
    start = datetime.combine(from_date, time.min, zone).astimezone(UTC)
    end = datetime.combine(to_date + timedelta(days=1), time.min, zone).astimezone(UTC)
    return list(
        db.scalars(
            select(ArchiveEntry)
            .where(
                ArchiveEntry.dormitory_id == dormitory_id,
                ArchiveEntry.created_at >= start,
                ArchiveEntry.created_at < end,
            )
            .order_by(ArchiveEntry.id)
        )
    )


@router.post("/archive/rows", response_model=ArchiveResponse, status_code=201)
def create_archive(dormitory_id: DormitoryId, _user: CurrentUser, db: DbSession) -> ArchiveEntry:
    lock_dormitory(db, dormitory_id)
    row = ArchiveEntry(dormitory_id=dormitory_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/archive/rows/{row_id}", status_code=204)
def delete_archive(
    dormitory_id: DormitoryId, row_id: ColumnId, _user: CurrentUser, db: DbSession
) -> None:
    lock_dormitory(db, dormitory_id)
    db.delete(get_record(db, dormitory_id, "archive", row_id))
    db.commit()
