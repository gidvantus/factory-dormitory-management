"""Помесячные хостелы и таблицы мест в общежитии."""

from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.reports import require_dormitory
from app.db import get_db
from app.models.hostel import Hostel, HostelCell
from app.schemas.hostel import (
    CreateHostelRequest,
    HostelMonthResponse,
    HostelResponse,
    PlaceField,
    PlacesResponse,
    SaveHostelCellRequest,
)
from app.security import ACTIVE_USER_RESPONSES, ActiveUser

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/hostels",
    tags=["hostels"],
    responses={**ACTIVE_USER_RESPONSES},
)
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
HostelId = Annotated[int, Path(ge=1, le=2147483647)]
GROUPS = (
    ("residents_m", "residents_f", "residents_total"),
    ("free_m", "free_f", "free_total"),
    ("paid_m", "paid_f", "paid_total"),
)


def next_month(month: date) -> date:
    return date(month.year + (month.month == 12), month.month % 12 + 1, 1)


def get_hostel(db: Session, dormitory_id: int, hostel_id: int) -> Hostel:
    hostel = db.get(Hostel, hostel_id)
    if hostel is None or hostel.dormitory_id != dormitory_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Хостел не найден")
    return hostel


def active_in_month(hostel: Hostel, month: date) -> bool:
    return hostel.active_from_month <= month and (
        hostel.active_until_month is None or hostel.active_until_month > month
    )


@router.get("", response_model=PlacesResponse, summary="Таблицы мест за период")
def read_places(
    dormitory_id: DormitoryId,
    _user: ActiveUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
) -> PlacesResponse:
    require_dormitory(db, dormitory_id)
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Выберите период не длиннее года")
    first_month = from_date.replace(day=1)
    last_month = to_date.replace(day=1)
    hostels = list(
        db.scalars(
            select(Hostel)
            .where(
                Hostel.dormitory_id == dormitory_id,
                Hostel.active_from_month <= last_month,
                or_(Hostel.active_until_month.is_(None), Hostel.active_until_month > first_month),
            )
            .order_by(Hostel.active_from_month, Hostel.id)
        )
    )
    cells = (
        list(
            db.scalars(
                select(HostelCell).where(
                    HostelCell.hostel_id.in_([hostel.id for hostel in hostels]),
                    HostelCell.report_date >= from_date,
                    HostelCell.report_date <= to_date,
                )
            )
        )
        if hostels
        else []
    )
    values: dict[int, dict[str, dict[str, int]]] = {hostel.id: {} for hostel in hostels}
    for cell in cells:
        values[cell.hostel_id].setdefault(cell.field, {})[cell.report_date.isoformat()] = cell.value

    months: list[HostelMonthResponse] = []
    month = first_month
    while month <= last_month:
        start = max(from_date, month)
        end = min(to_date, next_month(month) - timedelta(days=1))
        days = [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
        day_keys = {day.isoformat() for day in days}
        visible: list[HostelResponse] = []
        for hostel in hostels:
            if not active_in_month(hostel, month):
                continue
            row_values = {
                field: {day: value for day, value in day_values.items() if day in day_keys}
                for field, day_values in values[hostel.id].items()
            }
            for gender in ("m", "f"):
                paid = row_values.get(f"paid_{gender}", {})
                residents = row_values.get(f"residents_{gender}", {})
                row_values[f"free_{gender}"] = {
                    day: paid.get(day, 0) - residents.get(day, 0)
                    for day in paid.keys() | residents.keys()
                }
            for left, right, total in GROUPS:
                calculated = {
                    day.isoformat(): row_values.get(left, {}).get(day.isoformat(), 0)
                    + row_values.get(right, {}).get(day.isoformat(), 0)
                    for day in days
                    if day.isoformat() in row_values.get(left, {})
                    or day.isoformat() in row_values.get(right, {})
                }
                row_values[total] = calculated
            visible.append(HostelResponse(id=hostel.id, name=hostel.name, values=row_values))
        months.append(HostelMonthResponse(month=month, days=days, hostels=visible))
        month = next_month(month)
    return PlacesResponse(months=months)


@router.post("", status_code=status.HTTP_201_CREATED, summary="Добавить хостел")
def create_hostel(
    dormitory_id: DormitoryId,
    payload: CreateHostelRequest,
    _user: ActiveUser,
    db: DbSession,
) -> dict[str, int | str]:
    require_dormitory(db, dormitory_id)
    existing = db.scalars(select(Hostel).where(Hostel.dormitory_id == dormitory_id))
    if any(
        hostel.name.casefold() == payload.name.casefold()
        and (hostel.active_until_month is None or hostel.active_until_month > payload.month)
        for hostel in existing
    ):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Хостел с таким названием уже есть в этом месяце"
        )
    hostel = Hostel(dormitory_id=dormitory_id, name=payload.name, active_from_month=payload.month)
    db.add(hostel)
    db.commit()
    db.refresh(hostel)
    return {"id": hostel.id, "name": hostel.name}


@router.delete(
    "/{hostel_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Убрать хостел с месяца"
)
def remove_hostel(
    dormitory_id: DormitoryId,
    hostel_id: HostelId,
    _user: ActiveUser,
    db: DbSession,
    month: Annotated[date, Query()],
) -> None:
    require_dormitory(db, dormitory_id)
    if month.day != 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите первый день месяца")
    hostel = get_hostel(db, dormitory_id, hostel_id)
    if month < hostel.active_from_month:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Хостел ещё не создан в этом месяце"
        )
    if hostel.active_until_month is not None and hostel.active_until_month <= month:
        raise HTTPException(status.HTTP_409_CONFLICT, "Хостел уже убран с этого месяца")
    hostel.active_until_month = month
    db.commit()


@router.put(
    "/{hostel_id}/cells/{report_date}/{field}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Автоматически сохранить место за день",
)
def save_hostel_cell(
    dormitory_id: DormitoryId,
    hostel_id: HostelId,
    report_date: date,
    field: PlaceField,
    payload: SaveHostelCellRequest,
    _user: ActiveUser,
    db: DbSession,
) -> None:
    require_dormitory(db, dormitory_id)
    hostel = get_hostel(db, dormitory_id, hostel_id)
    if not active_in_month(hostel, report_date.replace(day=1)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Хостел не действует в этом месяце")
    cell = db.scalar(
        select(HostelCell).where(
            HostelCell.hostel_id == hostel_id,
            HostelCell.report_date == report_date,
            HostelCell.field == field,
        )
    )
    if payload.value is None:
        if cell is not None:
            db.delete(cell)
    elif cell is None:
        db.add(
            HostelCell(
                hostel_id=hostel_id, report_date=report_date, field=field, value=payload.value
            )
        )
    else:
        cell.value = payload.value
        cell.updated_at = func.now()
    db.commit()
