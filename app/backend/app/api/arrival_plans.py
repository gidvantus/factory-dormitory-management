"""Добавление и исправление планового количества приезжающих."""

from datetime import date, timedelta
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import arrival_workflow as workflow
from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser, own_dormitory, scoped_dormitories
from app.api.organization import Membership
from app.arrival_plans import active_arrivals, plan_response
from app.arrival_settings import (
    effective_people,
    lock_configuration,
    plan_values,
    save_settings,
    settings_response,
)
from app.db import get_db
from app.models.arrival_plan import ArrivalPlan
from app.models.dormitory import Dormitory
from app.personnel import today
from app.schemas.arrival_settings import ArrivalSettingsInput
from app.schemas.arrival_workflow import VisitMark, VisitMove, VisitVersion
from app.schemas.personnel import ArrivalInput, ArrivalUpdate
from app.table_data import lock_dormitory

router = APIRouter(
    prefix="/personnel/arrivals", tags=["personnel"], responses=SUBSCRIBED_USER_RESPONSES
)
DbSession = Annotated[Session, Depends(get_db)]


@router.get("")
def list_arrivals(
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
    dormitory_id: Annotated[int | None, Query(ge=1, le=2147483647)] = None,
) -> dict[str, Any]:
    start = from_date or today()
    end = to_date or start + timedelta(days=6)
    if start > end or (end - start).days > 365:
        raise HTTPException(422, "Выберите период не длиннее года")
    if dormitory_id is not None:
        own_dormitory(db, dormitory_id, membership)
    dormitories = [
        dorm for dorm in scoped_dormitories(db, membership.organization_id) if not dorm.is_archived
    ]
    ids = [dorm.id for dorm in dormitories if dormitory_id is None or dorm.id == dormitory_id]
    return {
        "today": today(),
        "from": start,
        "to": end,
        "dormitories": [
            {"id": d.id, "name": d.name, "client_name": d.client_name, "is_archived": False}
            for d in dormitories
        ],
        "arrival_plans": active_arrivals(db, ids, start, end),
        "arrival_settings": settings_response(db, membership.organization_id),
    }


def writable_dormitory(db: Session, dormitory_id: int, membership: Membership) -> Dormitory:
    """Общежитие организации из сессии, готовое к правке плана заездов.

    Порядок проверок: сначала права, потом блокировка. Чужое общежитие отвечает
    тем же `404`, что и несуществующее, и не блокируется.
    """
    dorm = own_dormitory(db, dormitory_id, membership)
    lock_dormitory(db, dormitory_id)
    if dorm.is_archived:
        raise HTTPException(409, "План заездов доступен только для действующих общежитий")
    return dorm


def get_plan(db: Session, plan_id: UUID, membership: Membership) -> ArrivalPlan:
    plan = db.scalar(
        select(ArrivalPlan)
        .join(Dormitory)
        .where(
            ArrivalPlan.id == str(plan_id), Dormitory.organization_id == membership.organization_id
        )
        .with_for_update(of=ArrivalPlan)
    )
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


@router.get("/settings")
def get_arrival_settings(
    _user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    return settings_response(db, membership.organization_id)


@router.put("/settings")
def update_arrival_settings(
    payload: ArrivalSettingsInput, _user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    return save_settings(db, membership.organization_id, payload)


@router.post("", status_code=201)
def create_arrival(
    payload: ArrivalInput, _user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    config = lock_configuration(db, membership.organization_id)
    writable_dormitory(db, payload.dormitory_id, membership)
    existing = db.scalar(
        select(ArrivalPlan.id).where(
            ArrivalPlan.dormitory_id == payload.dormitory_id,
            ArrivalPlan.date == payload.date,
        )
    )
    if existing:
        raise HTTPException(409, "На эту дату уже есть план для общежития. Отредактируйте его.")
    plan = ArrivalPlan(
        id=str(uuid4()),
        dormitory_id=payload.dormitory_id,
        date=payload.date,
        count=payload.count,
        names=[],
        custom_values={},
    )
    for field, value in plan_values(payload, plan, config).items():
        setattr(plan, field, value)
    db.add(plan)
    return commit_plan(db, plan)


@router.put("/{plan_id}")
def update_arrival(
    plan_id: UUID,
    payload: ArrivalUpdate,
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    config = lock_configuration(db, membership.organization_id)
    plan = get_plan(db, plan_id, membership)
    for dormitory_id in sorted({plan.dormitory_id, payload.dormitory_id}):
        writable_dormitory(db, dormitory_id, membership)
    db.refresh(plan, with_for_update=True)
    if plan.revision != payload.revision:
        raise HTTPException(409, "План уже изменён. Закройте окно и откройте запись заново.")
    values = plan_values(payload, plan, config)
    workflow.guard_edit(plan, values)
    # Скрытые исходные строки нужны только для истории и повтора запроса переноса.
    moved_ids = {visit.person_id for visit in plan.visits if visit.status == "moved"}
    values["people"].extend(
        person for person in effective_people(plan) if person["id"] in moved_ids
    )
    values["count"] = len(values["people"])
    values["names"] = [person["full_name"] for person in values["people"] if person["full_name"]]
    for field, value in values.items():
        setattr(plan, field, value)
    plan.revision += 1
    return commit_plan(db, plan)


@router.delete("/{plan_id}", status_code=204)
def delete_arrival(
    plan_id: UUID,
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    revision: Annotated[int, Query(ge=0)],
) -> None:
    lock_configuration(db, membership.organization_id)
    plan = get_plan(db, plan_id, membership)
    writable_dormitory(db, plan.dormitory_id, membership)
    db.refresh(plan, with_for_update=True)
    if plan.revision != revision:
        raise HTTPException(409, "План уже изменён. Закройте окно и откройте запись заново.")
    if plan.visits:
        raise HTTPException(409, "Заезд содержит отметки людей. Удаление уничтожило бы историю.")
    db.delete(plan)
    db.commit()


@router.get("/{plan_id}")
def read_arrival(
    plan_id: UUID, _user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    plan = db.scalar(
        select(ArrivalPlan)
        .join(Dormitory)
        .where(
            ArrivalPlan.id == str(plan_id), Dormitory.organization_id == membership.organization_id
        )
    )
    if plan is None:
        raise HTTPException(404, "Запись плана не найдена")
    dorm = db.get(Dormitory, plan.dormitory_id)
    assert dorm is not None
    return {**plan_response(plan), "dormitory_name": dorm.name, "is_archived": dorm.is_archived}


def workflow_plan(db: Session, plan_id: UUID, membership: Membership) -> ArrivalPlan:
    lock_configuration(db, membership.organization_id)
    plan = get_plan(db, plan_id, membership)
    writable_dormitory(db, plan.dormitory_id, membership)
    return plan


@router.post("/{plan_id}/people/{person_id}/status")
def mark_person(
    plan_id: UUID,
    person_id: UUID,
    payload: VisitMark,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    plan = workflow_plan(db, plan_id, membership)
    workflow.mark(plan, str(person_id), payload.status, payload.revision, user.id)
    db.commit()
    return {"plans": [plan_response(plan)], "deleted_plan_ids": []}


@router.post("/{plan_id}/people/{person_id}/move")
def move_person(
    plan_id: UUID,
    person_id: UUID,
    payload: VisitMove,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    plan = workflow_plan(db, plan_id, membership)
    target = workflow.move(db, plan, str(person_id), payload.date, payload.revision, user.id)
    db.commit()
    return {"plans": [plan_response(plan), plan_response(target)], "deleted_plan_ids": []}


@router.post("/{plan_id}/people/{person_id}/undo-move")
def undo_person_move(
    plan_id: UUID,
    person_id: UUID,
    payload: VisitVersion,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    plan = workflow_plan(db, plan_id, membership)
    target, deleted = workflow.undo_move(db, plan, str(person_id), payload.revision, user.id)
    target_id = target.id
    db.commit()
    return {
        "plans": [plan_response(plan)] + ([] if deleted else [plan_response(target)]),
        "deleted_plan_ids": [target_id] if deleted else [],
    }
