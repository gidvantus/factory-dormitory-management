"""Конструктор отчёта: строки, формулы и автоматически сохраняемые ячейки."""

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.dormitory import Dormitory
from app.models.report import ReportCell, ReportRow
from app.report_defaults import required_row_name
from app.report_formula import FormulaError, calculate_formula, compile_formula, format_number
from app.schemas.report import (
    CreateReportRowRequest,
    MoveReportRowRequest,
    ReportResponse,
    ReportRowResponse,
    SaveReportCellRequest,
    UpdateReportRowRequest,
)
from app.schemas.table_column import ReportLink
from app.schemas.user import ErrorResponse
from app.security import CurrentUser
from app.table_data import Record, linked_counts, lock_dormitory, records_for, validate_link

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/report",
    tags=["reports"],
    responses={401: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
)
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
RowId = Annotated[int, Path(ge=1, le=2147483647)]


def require_dormitory(db: Session, dormitory_id: int) -> None:
    if db.get(Dormitory, dormitory_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Общежитие не найдено")


def get_rows(db: Session, dormitory_id: int) -> list[ReportRow]:
    return list(
        db.scalars(
            select(ReportRow)
            .where(ReportRow.dormitory_id == dormitory_id)
            .order_by(ReportRow.position, ReportRow.id)
        )
    )


def get_row(db: Session, dormitory_id: int, row_id: int) -> ReportRow:
    row = db.get(ReportRow, row_id)
    if row is None or row.dormitory_id != dormitory_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка не найдена")
    return row


def check_names_and_formulas(formulas: dict[str, str | None]) -> None:
    references: dict[str, set[str]] = {}
    try:
        for name, formula in formulas.items():
            references[name] = compile_formula(formula)[1] if formula else set()
            if missing := references[name] - formulas.keys():
                raise FormulaError(f"Строка не найдена: {sorted(missing)[0]}")
        visited: set[str] = set()
        active: set[str] = set()

        def visit(name: str) -> None:
            if name in active:
                raise FormulaError("Формулы не могут ссылаться друг на друга по кругу")
            if name in visited:
                return
            active.add(name)
            for target in references[name]:
                visit(target)
            active.remove(name)
            visited.add(name)

        for name in formulas:
            visit(name)
    except (FormulaError, RecursionError) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc


def row_response(row: ReportRow) -> ReportRowResponse:
    return ReportRowResponse(
        id=row.id,
        name=row.name,
        position=row.position,
        formula=row.formula,
        link=row.link,
        values={},
        errors={},
    )


@router.get("", response_model=ReportResponse, summary="Большой отчёт за период")
def read_report(
    dormitory_id: DormitoryId,
    _user: CurrentUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
) -> ReportResponse:
    require_dormitory(db, dormitory_id)
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Выберите период не длиннее года")
    rows = get_rows(db, dormitory_id)
    result = [row_response(row) for row in rows]
    if not rows:
        return ReportResponse(from_date=from_date, to_date=to_date, rows=result)
    cells = db.scalars(
        select(ReportCell).where(
            ReportCell.row_id.in_([row.id for row in rows]),
            ReportCell.report_date >= from_date,
            ReportCell.report_date <= to_date,
        )
    )
    raw = {(cell.row_id, cell.report_date): cell.value for cell in cells}
    names = {row.name: row for row in rows}
    compiled = {row.id: compile_formula(row.formula)[0] for row in rows if row.formula}
    linked_values: dict[int, dict[date, int]] = {}
    link_errors: dict[int, str] = {}
    source_records: dict[str, list[Record]] = {}
    for row in rows:
        if row.link:
            try:
                link = ReportLink.model_validate(row.link)
                if link.table_key not in source_records:
                    source_records[link.table_key] = records_for(db, dormitory_id, link.table_key)
                linked_values[row.id] = linked_counts(
                    db,
                    dormitory_id,
                    link,
                    source_records[link.table_key],
                    from_date,
                    to_date,
                )
            except (HTTPException, ValueError) as exc:
                detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
                link_errors[row.id] = f"Проверьте связь: {detail}"
    days = (from_date + timedelta(days=offset) for offset in range((to_date - from_date).days + 1))

    for day in days:
        cache: dict[str, Decimal] = {}

        def value_for(name: str, *, day: date = day, cache: dict[str, Decimal] = cache) -> Decimal:
            if name in cache:
                return cache[name]
            row = names.get(name)
            if row is None:
                raise FormulaError(f"Строка не найдена: {name}")
            if row.link:
                if row.id in link_errors:
                    raise FormulaError(link_errors[row.id])
                value = Decimal(linked_values[row.id].get(day, 0))
            elif row.formula:
                value = calculate_formula(compiled[row.id], value_for)
            else:
                text = raw.get((row.id, day))
                if text is None:
                    value = Decimal(0)
                else:
                    try:
                        value = Decimal(text.replace(",", "."))
                        if not value.is_finite():
                            raise InvalidOperation
                    except InvalidOperation as exc:
                        raise FormulaError(f"В строке «{name}» за {day} не число") from exc
            cache[name] = value
            return value

        for row, output in zip(rows, result, strict=True):
            if not row.formula and not row.link:
                if (cell_value := raw.get((row.id, day))) is not None:
                    output.values[day.isoformat()] = cell_value
                continue
            try:
                output.values[day.isoformat()] = format_number(value_for(row.name))
            except (FormulaError, InvalidOperation, OverflowError) as exc:
                output.errors[day.isoformat()] = str(exc)

    return ReportResponse(from_date=from_date, to_date=to_date, rows=result)


@router.post(
    "/rows",
    response_model=ReportRowResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить строку отчёта",
)
def create_row(
    dormitory_id: DormitoryId,
    payload: CreateReportRowRequest,
    _user: CurrentUser,
    db: DbSession,
) -> ReportRowResponse:
    lock_dormitory(db, dormitory_id)
    if payload.link and payload.formula:
        raise HTTPException(422, "Выберите формулу или связь с таблицей")
    link = validate_link(db, dormitory_id, payload.link) if payload.link else None
    rows = get_rows(db, dormitory_id)
    if any(row.name.casefold() == payload.name.casefold() for row in rows):
        raise HTTPException(status.HTTP_409_CONFLICT, "Строка с таким названием уже есть")
    check_names_and_formulas(
        {**{row.name: row.formula for row in rows}, payload.name: payload.formula}
    )
    row = ReportRow(
        dormitory_id=dormitory_id,
        name=payload.name,
        formula=payload.formula,
        link=link.model_dump() if link else None,
        position=max((item.position for item in rows), default=0) + 1,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Строка с таким названием уже есть") from exc
    db.refresh(row)
    return row_response(row)


@router.patch("/rows/{row_id}", response_model=ReportRowResponse, summary="Изменить строку отчёта")
def update_row(
    dormitory_id: DormitoryId,
    row_id: RowId,
    payload: UpdateReportRowRequest,
    _user: CurrentUser,
    db: DbSession,
) -> ReportRowResponse:
    lock_dormitory(db, dormitory_id)
    row = get_row(db, dormitory_id, row_id)
    if not payload.model_fields_set:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите изменение")
    if "name" in payload.model_fields_set and payload.name is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите название строки")
    rows = get_rows(db, dormitory_id)
    old_name = row.name
    new_name = payload.name if payload.name is not None else old_name
    if required_row_name(old_name):
        if new_name != old_name:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Название обязательной строки нельзя изменить"
            )
        if "formula" in payload.model_fields_set and payload.formula is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Обязательная строка должна оставаться формулой"
            )
    if any(item.id != row.id and item.name.casefold() == new_name.casefold() for item in rows):
        raise HTTPException(status.HTTP_409_CONFLICT, "Строка с таким названием уже есть")
    replacements = {
        item.id: item.formula.replace(f"[{old_name}]", f"[{new_name}]") if item.formula else None
        for item in rows
    }
    if "formula" in payload.model_fields_set:
        replacements[row.id] = payload.formula
    link = (
        (payload.link.model_dump() if payload.link else None)
        if "link" in payload.model_fields_set
        else row.link
    )
    if link:
        if replacements[row.id] or required_row_name(old_name):
            raise HTTPException(422, "Выберите формулу или связь с таблицей")
        link = validate_link(db, dormitory_id, ReportLink.model_validate(link)).model_dump()
    check_names_and_formulas(
        {new_name if item.id == row.id else item.name: replacements[item.id] for item in rows}
    )
    if row.formula is None and row.link is None and (replacements[row.id] is not None or link):
        db.execute(delete(ReportCell).where(ReportCell.row_id == row.id))
    for item in rows:
        item.formula = replacements[item.id]
    row.name = new_name
    row.link = link
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Строка с таким названием уже есть") from exc
    db.refresh(row)
    return row_response(row)


@router.patch("/rows/{row_id}/move", response_model=ReportRowResponse, summary="Переместить строку")
def move_row(
    dormitory_id: DormitoryId,
    row_id: RowId,
    payload: MoveReportRowRequest,
    _user: CurrentUser,
    db: DbSession,
) -> ReportRowResponse:
    require_dormitory(db, dormitory_id)
    rows = get_rows(db, dormitory_id)
    index = next((index for index, row in enumerate(rows) if row.id == row_id), None)
    if index is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка не найдена")
    neighbor_index = index + (-1 if payload.direction == "up" else 1)
    if neighbor_index < 0 or neighbor_index >= len(rows):
        raise HTTPException(status.HTTP_409_CONFLICT, "Строку нельзя переместить дальше")
    row = rows[index]
    neighbor = rows[neighbor_index]
    row.position, neighbor.position = neighbor.position, row.position
    db.commit()
    db.refresh(row)
    return row_response(row)


@router.delete("/rows/{row_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить строку")
def delete_row(dormitory_id: DormitoryId, row_id: RowId, _user: CurrentUser, db: DbSession) -> None:
    require_dormitory(db, dormitory_id)
    row = get_row(db, dormitory_id, row_id)
    if required_row_name(row.name):
        raise HTTPException(status.HTTP_409_CONFLICT, "Обязательную строку нельзя удалить")
    for item in get_rows(db, dormitory_id):
        if item.id != row_id and item.formula and row.name in compile_formula(item.formula)[1]:
            raise HTTPException(status.HTTP_409_CONFLICT, "На строку ссылаются другие формулы")
    db.execute(delete(ReportCell).where(ReportCell.row_id == row_id))
    db.delete(row)
    db.commit()


@router.put(
    "/rows/{row_id}/cells/{report_date}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Автоматически сохранить ячейку",
)
def save_cell(
    dormitory_id: DormitoryId,
    row_id: RowId,
    report_date: date,
    payload: SaveReportCellRequest,
    _user: CurrentUser,
    db: DbSession,
) -> None:
    lock_dormitory(db, dormitory_id)
    row = get_row(db, dormitory_id, row_id)
    if row.formula:
        raise HTTPException(status.HTTP_409_CONFLICT, "Формульную строку нельзя заполнить вручную")
    if row.link:
        raise HTTPException(status.HTTP_409_CONFLICT, "Связанную строку нельзя заполнить вручную")
    cell = db.scalar(
        select(ReportCell).where(ReportCell.row_id == row_id, ReportCell.report_date == report_date)
    )
    if payload.value is None:
        if cell is not None:
            db.delete(cell)
    elif cell is None:
        db.add(ReportCell(row_id=row_id, report_date=report_date, value=payload.value))
    else:
        cell.value = payload.value
        cell.updated_at = func.now()
    db.commit()
