"""Записи о притоке персонала."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.reports import require_dormitory
from app.db import get_db
from app.models.inflow import PersonnelInflow
from app.schemas.inflow import InflowResponse, UpdateInflowRequest
from app.security import ACTIVE_USER_RESPONSES, ActiveUser

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/inflow",
    tags=["inflow"],
    responses={**ACTIVE_USER_RESPONSES},
)
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
InflowId = Annotated[int, Path(ge=1, le=2147483647)]


def get_inflow(db: Session, dormitory_id: int, row_id: int) -> PersonnelInflow:
    row = db.get(PersonnelInflow, row_id)
    if row is None or row.dormitory_id != dormitory_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка притока не найдена")
    return row


@router.get("", response_model=list[InflowResponse], summary="Приток персонала за период")
def list_inflow(
    dormitory_id: DormitoryId,
    _user: ActiveUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
) -> list[PersonnelInflow]:
    require_dormitory(db, dormitory_id)
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Выберите период не длиннее года")
    return list(
        db.scalars(
            select(PersonnelInflow)
            .where(
                PersonnelInflow.dormitory_id == dormitory_id,
                or_(
                    PersonnelInflow.settlement_date.is_(None),
                    PersonnelInflow.settlement_date.between(from_date, to_date),
                ),
            )
            .order_by(PersonnelInflow.id)
        )
    )


@router.post(
    "",
    response_model=InflowResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить строку притока",
)
def create_inflow(dormitory_id: DormitoryId, _user: ActiveUser, db: DbSession) -> PersonnelInflow:
    require_dormitory(db, dormitory_id)
    row = PersonnelInflow(dormitory_id=dormitory_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{row_id}", response_model=InflowResponse, summary="Сохранить строку притока")
def update_inflow(
    dormitory_id: DormitoryId,
    row_id: InflowId,
    payload: UpdateInflowRequest,
    _user: ActiveUser,
    db: DbSession,
) -> PersonnelInflow:
    require_dormitory(db, dormitory_id)
    row = get_inflow(db, dormitory_id, row_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete(
    "/{row_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить строку притока"
)
def delete_inflow(
    dormitory_id: DormitoryId,
    row_id: InflowId,
    _user: ActiveUser,
    db: DbSession,
) -> None:
    require_dormitory(db, dormitory_id)
    db.delete(get_inflow(db, dormitory_id, row_id))
    db.commit()
