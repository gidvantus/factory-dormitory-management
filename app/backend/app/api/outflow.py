"""Записи об оттоке персонала."""

from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser
from app.db import get_db
from app.models.outflow import PersonnelOutflow
from app.notifications import capture_resident_outflow, queue_resident_outflow
from app.outflow_eviction import prepare_eviction
from app.outflow_fields import field_columns, outflow_fields, remember_reason
from app.personnel import record_changed
from app.schemas.outflow import (
    OutflowEvictionPreview,
    OutflowEvictionRequest,
    OutflowFields,
    OutflowResponse,
    UpdateOutflowRequest,
)
from app.section_state import require_section_writable
from app.table_data import ensure_columns, lock_dormitory

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/outflow",
    tags=["outflow"],
    responses={**SUBSCRIBED_USER_RESPONSES},
)
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
    _user: SubscribedUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
    _dormitory: OwnDormitory,
) -> list[PersonnelOutflow]:
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
            .order_by(PersonnelOutflow.id.desc())
        )
    )


@router.post(
    "",
    response_model=OutflowResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить строку оттока",
)
def create_outflow(
    dormitory_id: DormitoryId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> PersonnelOutflow:
    require_section_writable(db, dormitory_id, "outflow")
    row = PersonnelOutflow(dormitory_id=dormitory_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/fields", response_model=OutflowFields)
def read_fields(
    dormitory_id: DormitoryId, _user: SubscribedUser, db: DbSession, _dormitory: OwnDormitory
) -> OutflowFields:
    result = outflow_fields(db, dormitory_id)
    db.commit()
    return result


@router.patch("/{row_id}", response_model=OutflowResponse, summary="Сохранить строку оттока")
def update_outflow(
    dormitory_id: DormitoryId,
    row_id: OutflowId,
    payload: UpdateOutflowRequest,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> PersonnelOutflow:
    require_section_writable(db, dormitory_id, "outflow")
    lock_dormitory(db, dormitory_id)
    row = get_outflow(db, dormitory_id, row_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if field == "reason" and value:
            reason, _ = field_columns(ensure_columns(db, dormitory_id, "outflow"))
            if reason and reason.kind == "text" and reason.builtin_key == "reason":
                value = remember_reason(db, reason, value)
        setattr(row, field, value)
    record_changed(db, row, _user.id)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{row_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить строку оттока")
def delete_outflow(
    dormitory_id: DormitoryId,
    row_id: OutflowId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> None:
    require_section_writable(db, dormitory_id, "outflow")
    lock_dormitory(db, dormitory_id)
    row = get_outflow(db, dormitory_id, row_id)
    if row.evicted_at:
        raise HTTPException(409, "Сотрудник уже выселен. Действия по этой строке недоступны")
    record_changed(db, row, _user.id, kind="deleted", title="Удалена исходная запись оттока")
    db.delete(row)
    db.commit()


@router.post("/{row_id}/evict/preview", response_model=OutflowEvictionPreview)
def preview_eviction(
    dormitory_id: DormitoryId,
    row_id: OutflowId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> OutflowEvictionPreview:
    plan = prepare_eviction(db, dormitory_id, row_id)
    db.commit()
    return plan.preview


@router.post("/{row_id}/evict", response_model=OutflowResponse, summary="Выселить сотрудника")
def evict_employee(
    dormitory_id: DormitoryId,
    row_id: OutflowId,
    payload: OutflowEvictionRequest,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> PersonnelOutflow:
    plan = prepare_eviction(db, dormitory_id, row_id)
    if payload.preview_token != plan.preview.preview_token:
        raise HTTPException(409, "Проживание или выплаты изменились. Повторно проверьте выселение")
    notifications = []
    for resident in plan.residents:
        record_changed(
            db, resident, _user.id, kind="outflow", title="Проживание завершено · выселение"
        )
        notifications.append(
            capture_resident_outflow(db, resident, departure_date=plan.row.departure_date)
        )
    for payment in plan.payments:
        db.delete(payment)
    # Удаляем выплаты до проживающих, чтобы сохранить порядок внешних ключей.
    db.flush()
    for resident in plan.residents:
        db.delete(resident)
    plan.row.evicted_at = datetime.now(UTC)
    record_changed(db, plan.row, _user.id, kind="outflow", title="Сотрудник выселен")
    db.commit()
    for notification in notifications:
        queue_resident_outflow(db, resident=notification, actor_id=_user.id)
    db.refresh(plan.row)
    return plan.row
