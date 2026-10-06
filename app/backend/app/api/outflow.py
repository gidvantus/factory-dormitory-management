"""Записи об оттоке персонала."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.reports import require_dormitory
from app.db import get_db
from app.models.outflow import PersonnelOutflow
from app.schemas.outflow import OutflowResponse, UpdateOutflowRequest
from app.security import CurrentUser

router = APIRouter(prefix="/dormitories/{dormitory_id}/outflow", tags=["outflow"])
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
OutflowId = Annotated[int, Path(ge=1, le=2147483647)]


def get_outflow(db: Session, dormitory_id: int, row_id: int) -> PersonnelOutflow:
    row = db.get(PersonnelOutflow, row_id)
    if row is None or row.dormitory_id != dormitory_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка оттока не найдена")
    return row


@router.get("", response_model=list[OutflowResponse], summary="Отток персонала за период")
def list_outflow(
    dormitory_id: DormitoryId,
    _user: CurrentUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
) -> list[PersonnelOutflow]:
    require_dormitory(db, dormitory_id)
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Выберите период не длиннее года")
    return list(
        db.scalars(
            select(PersonnelOutflow)
            .where(
                PersonnelOutflow.dormitory_id == dormitory_id,
                or_(
                    PersonnelOutflow.departure_date.is_(None),
                    PersonnelOutflow.departure_date.between(from_date, to_date),
                ),
            )
            .order_by(PersonnelOutflow.id)
        )
    )


@router.post(
    "",
    response_model=OutflowResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить строку оттока",
)
def create_outflow(
    dormitory_id: DormitoryId, _user: CurrentUser, db: DbSession
) -> PersonnelOutflow:
    require_dormitory(db, dormitory_id)
    row = PersonnelOutflow(dormitory_id=dormitory_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{row_id}", response_model=OutflowResponse, summary="Сохранить строку оттока")
def update_outflow(
    dormitory_id: DormitoryId,
    row_id: OutflowId,
    payload: UpdateOutflowRequest,
    _user: CurrentUser,
    db: DbSession,
) -> PersonnelOutflow:
    require_dormitory(db, dormitory_id)
    row = get_outflow(db, dormitory_id, row_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{row_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить строку оттока")
def delete_outflow(
    dormitory_id: DormitoryId,
    row_id: OutflowId,
    _user: CurrentUser,
    db: DbSession,
) -> None:
    require_dormitory(db, dormitory_id)
    db.delete(get_outflow(db, dormitory_id, row_id))
    db.commit()
