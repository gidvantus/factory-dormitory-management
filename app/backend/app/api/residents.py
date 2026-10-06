"""Список проживающих, общий для пользователей общежития."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.reports import require_dormitory
from app.db import get_db
from app.models.hostel import Hostel
from app.models.resident import Resident
from app.schemas.resident import (
    HostelOption,
    ResidentResponse,
    ResidentsResponse,
    UpdateResidentRequest,
)
from app.security import CurrentUser

router = APIRouter(prefix="/dormitories/{dormitory_id}/residents", tags=["residents"])
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
ResidentId = Annotated[int, Path(ge=1, le=2147483647)]


def get_resident(db: Session, dormitory_id: int, resident_id: int) -> Resident:
    resident = db.get(Resident, resident_id)
    if resident is None or resident.dormitory_id != dormitory_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Проживающий не найден")
    return resident


def resident_response(db: Session, resident: Resident) -> ResidentResponse:
    hostel = db.get(Hostel, resident.hostel_id) if resident.hostel_id else None
    return ResidentResponse.model_validate(
        {**resident.__dict__, "hostel_name": hostel.name if hostel else None}
    )


@router.get("", response_model=ResidentsResponse, summary="Проживающие и действующие хостелы")
def list_residents(
    dormitory_id: DormitoryId,
    _user: CurrentUser,
    db: DbSession,
    month: Annotated[date, Query()],
) -> ResidentsResponse:
    require_dormitory(db, dormitory_id)
    if month.day != 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите первый день месяца")
    residents = db.scalars(
        select(Resident).where(Resident.dormitory_id == dormitory_id).order_by(Resident.id)
    ).all()
    hostels = db.scalars(
        select(Hostel)
        .where(
            Hostel.dormitory_id == dormitory_id,
            Hostel.active_from_month <= month,
            or_(Hostel.active_until_month.is_(None), Hostel.active_until_month > month),
        )
        .order_by(Hostel.name, Hostel.id)
    ).all()
    return ResidentsResponse(
        residents=[resident_response(db, resident) for resident in residents],
        hostels=[HostelOption(id=hostel.id, name=hostel.name) for hostel in hostels],
    )


@router.post(
    "",
    response_model=ResidentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить строку",
)
def create_resident(
    dormitory_id: DormitoryId, _user: CurrentUser, db: DbSession
) -> ResidentResponse:
    require_dormitory(db, dormitory_id)
    resident = Resident(dormitory_id=dormitory_id)
    db.add(resident)
    db.commit()
    db.refresh(resident)
    return resident_response(db, resident)


@router.patch(
    "/{resident_id}", response_model=ResidentResponse, summary="Сохранить поля проживающего"
)
def update_resident(
    dormitory_id: DormitoryId,
    resident_id: ResidentId,
    payload: UpdateResidentRequest,
    _user: CurrentUser,
    db: DbSession,
    month: Annotated[date, Query()],
) -> ResidentResponse:
    require_dormitory(db, dormitory_id)
    resident = get_resident(db, dormitory_id, resident_id)
    if month.day != 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Укажите первый день месяца")
    changes = payload.model_dump(exclude_unset=True)
    if "hostel_id" in changes and changes["hostel_id"] is not None:
        hostel = db.get(Hostel, changes["hostel_id"])
        if (
            hostel is None
            or hostel.dormitory_id != dormitory_id
            or hostel.active_from_month > month
            or (hostel.active_until_month is not None and hostel.active_until_month <= month)
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Хостел не действует в этом месяце"
            )
    start = changes.get("shift_start", resident.shift_start)
    end = changes.get("shift_end", resident.shift_end)
    if start is not None and end is not None and end < start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Конец вахты раньше начала")
    for field, value in changes.items():
        setattr(resident, field, value)
    db.commit()
    db.refresh(resident)
    return resident_response(db, resident)


@router.delete("/{resident_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить строку")
def delete_resident(
    dormitory_id: DormitoryId,
    resident_id: ResidentId,
    _user: CurrentUser,
    db: DbSession,
) -> None:
    require_dormitory(db, dormitory_id)
    db.delete(get_resident(db, dormitory_id, resident_id))
    db.commit()
