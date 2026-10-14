"""Записи о притоке персонала."""

from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser
from app.api.reports import require_dormitory
from app.db import get_db
from app.inflow_actions import InflowAction, prepare_inflow_action
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.resident import Resident
from app.outflow_fields import apply_outflow_fields
from app.personnel import fulfill_arrival, group_ids, record_changed
from app.schemas.inflow import (
    InflowActionPreview,
    InflowActionRequest,
    InflowActionResponse,
    InflowResponse,
    UpdateInflowRequest,
)
from app.section_state import require_section_writable

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/inflow",
    tags=["inflow"],
    responses={**SUBSCRIBED_USER_RESPONSES},
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
    _user: SubscribedUser,
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
            .order_by(PersonnelInflow.id.desc())
        )
    )


@router.post(
    "",
    response_model=InflowResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить строку притока",
)
def create_inflow(
    dormitory_id: DormitoryId, _user: SubscribedUser, db: DbSession
) -> PersonnelInflow:
    require_section_writable(db, dormitory_id, "inflow")
    require_dormitory(db, dormitory_id)
    row = PersonnelInflow(dormitory_id=dormitory_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.post("/{row_id}/{action}/preview", response_model=InflowActionPreview)
def preview_action(
    dormitory_id: DormitoryId,
    row_id: InflowId,
    action: InflowAction,
    _user: SubscribedUser,
    db: DbSession,
) -> InflowActionPreview:
    plan = prepare_inflow_action(db, dormitory_id, row_id, action)
    db.commit()
    return plan.preview


@router.post("/{row_id}/{action}", response_model=InflowActionResponse, status_code=201)
def process_inflow(
    dormitory_id: DormitoryId,
    row_id: InflowId,
    action: InflowAction,
    payload: InflowActionRequest,
    user: SubscribedUser,
    db: DbSession,
) -> InflowActionResponse:
    plan = prepare_inflow_action(db, dormitory_id, row_id, action)
    if payload.preview_token != plan.preview.preview_token:
        raise HTTPException(409, "Данные или столбцы изменились. Подтвердите действие ещё раз")
    values = payload.model_dump(exclude_unset=True, include={"reason", "departure_date"})
    if action == "outflow":
        available = plan.preview.fields
        if available and available.reason_column and not values.get("reason"):
            raise HTTPException(422, "Укажите причину оттока")
        if available and available.departure_column and not values.get("departure_date"):
            raise HTTPException(422, "Укажите дату оттока")
        apply_outflow_fields(db, dormitory_id, plan.fields, plan.custom, values)
    elif values:
        raise HTTPException(422, "Причина и дата оттока не используются при заселении")
    record_changed(db, plan.source, user.id)
    if not plan.source.employee_id:
        raise HTTPException(422, "Заполните данные сотрудника в притоке")
    if action == "settle" and db.scalar(
        select(Resident.id).where(Resident.employee_id.in_(group_ids(db, plan.source.employee_id)))
    ):
        raise HTTPException(
            409, "Этот сотрудник уже есть в «Проживающих». Сначала оформите его выезд или перевод"
        )
    model = Resident if action == "settle" else PersonnelOutflow
    target = model(
        dormitory_id=dormitory_id,
        employee_id=plan.source.employee_id,
        custom_values=plan.custom,
        **plan.fields,
    )
    db.add(target)
    db.flush()
    record_changed(db, target, user.id)
    if isinstance(target, Resident):
        fulfill_arrival(db, target, user.id)
    plan.source.processed_as = plan.preview.destination
    plan.source.processed_row_id = target.id
    plan.source.processed_at = datetime.now(UTC)
    record_changed(
        db,
        plan.source,
        user.id,
        kind="source",
        title="Приток · заселён в общежитие" if action == "settle" else "Приток · записан в отток",
    )
    db.commit()
    return InflowActionResponse(
        inflow=InflowResponse.model_validate(plan.source),
        destination=plan.preview.destination,
        row_id=target.id,
    )


@router.patch("/{row_id}", response_model=InflowResponse, summary="Сохранить строку притока")
def update_inflow(
    dormitory_id: DormitoryId,
    row_id: InflowId,
    payload: UpdateInflowRequest,
    _user: SubscribedUser,
    db: DbSession,
) -> PersonnelInflow:
    require_section_writable(db, dormitory_id, "inflow")
    require_dormitory(db, dormitory_id)
    row = get_inflow(db, dormitory_id, row_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    record_changed(db, row, _user.id)
    db.commit()
    db.refresh(row)
    return row


@router.delete(
    "/{row_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить строку притока"
)
def delete_inflow(
    dormitory_id: DormitoryId,
    row_id: InflowId,
    _user: SubscribedUser,
    db: DbSession,
) -> None:
    require_section_writable(db, dormitory_id, "inflow")
    require_dormitory(db, dormitory_id)
    row = get_inflow(db, dormitory_id, row_id)
    record_changed(db, row, _user.id, kind="deleted", title="Удалена исходная запись притока")
    db.delete(row)
    db.commit()
