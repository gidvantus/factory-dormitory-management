"""Добавление и исправление планового количества приезжающих."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser
from app.arrival_plans import plan_response
from app.db import get_db
from app.models.arrival_plan import ArrivalPlan
from app.models.dormitory import Dormitory
from app.schemas.personnel import ArrivalInput, ArrivalUpdate
from app.table_data import lock_dormitory

router = APIRouter(
    prefix="/personnel/arrivals", tags=["personnel"], responses=SUBSCRIBED_USER_RESPONSES
)
DbSession = Annotated[Session, Depends(get_db)]


def writable_dormitory(db: Session, dormitory_id: int) -> None:
    lock_dormitory(db, dormitory_id)
    dorm = db.get(Dormitory, dormitory_id)
    if dorm is None:
        raise HTTPException(404, "Общежитие не найдено")
    if dorm.is_archived:
        raise HTTPException(409, "План заездов доступен только для действующих общежитий")


def get_plan(db: Session, plan_id: UUID) -> ArrivalPlan:
    plan = db.scalar(select(ArrivalPlan).where(ArrivalPlan.id == str(plan_id)).with_for_update())
    if plan is None:
        raise HTTPException(404, "Запись плана не найдена")
    return plan


def commit_plan(db: Session, plan: ArrivalPlan) -> dict[str, Any]:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            409, "На эту дату уже есть план для общежития. Отредактируйте его."
        ) from exc
    db.refresh(plan)
    return plan_response(plan)


@router.post("", status_code=201)
def create_arrival(payload: ArrivalInput, _user: SubscribedUser, db: DbSession) -> dict[str, Any]:
    writable_dormitory(db, payload.dormitory_id)
    existing = db.scalar(
        select(ArrivalPlan.id).where(
            ArrivalPlan.dormitory_id == payload.dormitory_id,
            ArrivalPlan.date == payload.date,
        )
    )
    if existing:
        raise HTTPException(409, "На эту дату уже есть план для общежития. Отредактируйте его.")
    plan = ArrivalPlan(**payload.model_dump())
    db.add(plan)
    return commit_plan(db, plan)


@router.put("/{plan_id}")
def update_arrival(
    plan_id: UUID, payload: ArrivalUpdate, _user: SubscribedUser, db: DbSession
) -> dict[str, Any]:
    plan = get_plan(db, plan_id)
    for dormitory_id in sorted({plan.dormitory_id, payload.dormitory_id}):
        writable_dormitory(db, dormitory_id)
    db.refresh(plan, with_for_update=True)
    if plan.revision != payload.revision:
        raise HTTPException(409, "План уже изменён. Закройте окно и откройте запись заново.")
    for field, value in payload.model_dump(exclude={"revision"}).items():
        setattr(plan, field, value)
    plan.revision += 1
    return commit_plan(db, plan)


@router.delete("/{plan_id}", status_code=204)
def delete_arrival(
    plan_id: UUID, _user: SubscribedUser, db: DbSession, revision: Annotated[int, Query(ge=0)]
) -> None:
    plan = get_plan(db, plan_id)
    writable_dormitory(db, plan.dormitory_id)
    db.refresh(plan, with_for_update=True)
    if plan.revision != revision:
        raise HTTPException(409, "План уже изменён. Закройте окно и откройте запись заново.")
    db.delete(plan)
    db.commit()
