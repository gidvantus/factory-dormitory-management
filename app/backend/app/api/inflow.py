"""Записи о притоке персонала."""

from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app import notification_rules
from app.access import (
    SUBSCRIBED_USER_RESPONSES,
    OwnDormitory,
    SubscribedUser,
    scoped_dormitories,
)
from app.api.organization import Membership
from app.db import get_db
from app.inflow_actions import InflowAction, prepare_inflow_action
from app.inflow_entry import copy_entry_to_inflow, entry_form, resident_data
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.resident import Resident
from app.outflow_fields import apply_outflow_fields
from app.personnel import (
    IDENTITY_FIELDS,
    choose_identity,
    event,
    fulfill_arrival,
    group_ids,
    identity_lock,
    record_changed,
)
from app.schemas.inflow import (
    InflowActionPreview,
    InflowActionRequest,
    InflowActionResponse,
    InflowEntryForm,
    InflowEntryRequest,
    InflowResponse,
    UpdateInflowRequest,
)
from app.schemas.resident import UpdateResidentRequest
from app.section_state import require_section_writable
from app.table_data import ensure_columns, lock_dormitory

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
    _dormitory: OwnDormitory,
) -> list[PersonnelInflow]:
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
    dormitory_id: DormitoryId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> PersonnelInflow:
    require_section_writable(db, dormitory_id, "inflow")
    row = PersonnelInflow(dormitory_id=dormitory_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    notification_rules.notify_row_written(
        db, dormitory_id=dormitory_id, table_key="inflow", row_id=row.id, actor_id=_user.id
    )
    return row


@router.post("/{row_id}/{action}/preview", response_model=InflowActionPreview)
def preview_action(
    dormitory_id: DormitoryId,
    row_id: InflowId,
    action: InflowAction,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> InflowActionPreview:
    plan = prepare_inflow_action(db, dormitory_id, row_id, action)
    db.commit()
    return plan.preview


@router.get("/entry-form", response_model=InflowEntryForm)
def read_entry_form(
    dormitory_id: DormitoryId,
    month: Annotated[date, Query()],
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> InflowEntryForm:
    result = entry_form(db, dormitory_id, month)
    db.commit()
    return result


@router.post("/entries", response_model=InflowResponse, status_code=201)
def create_entry(
    dormitory_id: DormitoryId,
    payload: InflowEntryRequest,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> PersonnelInflow:
    lock_dormitory(db, dormitory_id)
    require_section_writable(db, dormitory_id, "inflow")
    form = entry_form(db, dormitory_id, payload.month)
    if form.schema_token != payload.schema_token:
        raise HTTPException(409, "Столбцы или места проживания изменились. Проверьте форму ещё раз")
    columns = ensure_columns(db, dormitory_id, "residents")
    fields, custom, saved = resident_data(columns, payload.values, {h.id for h in form.hostels})
    for field in IDENTITY_FIELDS:
        if field in fields and fields[field] != getattr(payload.identity, field):
            raise HTTPException(422, "Данные сотрудника изменились. Повторите проверку совпадений")
    identity_lock(db)
    employee = choose_identity(
        db,
        payload.identity,
        [item.id for item in scoped_dormitories(db, membership.organization_id)],
    )
    # Из выбранной карточки можно подставить известные данные в оставленные пустыми поля.
    for column in columns:
        identity_field = column.builtin_key
        if (
            not column.archived
            and identity_field is not None
            and identity_field in IDENTITY_FIELDS
            and not fields.get(identity_field)
        ):
            fields[identity_field] = getattr(payload.identity, identity_field) or getattr(
                employee, identity_field
            )
    try:
        resident_fields = UpdateResidentRequest.model_validate(fields)
    except ValidationError as exc:
        raise HTTPException(422, "Проверьте данные сотрудника и формат телефона") from exc
    for column in columns:
        if str(column.id) in saved and column.builtin_key:
            saved[str(column.id)]["value"] = resident_fields.model_dump(mode="json")[
                column.builtin_key
            ]
    resident = Resident(custom_values=custom, **resident_fields.model_dump(exclude_unset=True))
    inflow_columns = ensure_columns(db, dormitory_id, "inflow")
    inflow_fields, inflow_custom = copy_entry_to_inflow(resident, columns, inflow_columns)
    for field in ("full_name", "personnel_number"):
        if any(not col.archived and col.builtin_key == field for col in inflow_columns):
            inflow_fields.setdefault(
                field, getattr(payload.identity, field) or getattr(employee, field)
            )
    row = PersonnelInflow(
        dormitory_id=dormitory_id,
        employee_id=employee.id,
        custom_values=inflow_custom,
        resident_values={"month": payload.month.isoformat(), "columns": saved},
        **inflow_fields,
    )
    db.add(row)
    db.flush()
    record_changed(db, row, user.id)
    event(
        db,
        employee.id,
        "identity",
        "Выбрана существующая карточка"
        if payload.identity.mode == "existing"
        else "Создана карточка сотрудника",
        user.id,
        dormitory_id=dormitory_id,
        source_table="inflow",
        source_id=row.id,
        snapshot={"choice": payload.identity.mode},
    )
    db.commit()
    db.refresh(row)
    # Новая строка притока: правила этой таблицы ставятся после коммита.
    notification_rules.notify_row_written(
        db, dormitory_id=dormitory_id, table_key="inflow", row_id=row.id, actor_id=user.id
    )
    return row


@router.post("/{row_id}/{action}", response_model=InflowActionResponse, status_code=201)
def process_inflow(
    dormitory_id: DormitoryId,
    row_id: InflowId,
    action: InflowAction,
    payload: InflowActionRequest,
    user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
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
    # События двух таблиц: обработанная строка притока и созданная ею строка
    # назначения. Обе записи уже закоммичены, хуки идут после коммита.
    notification_rules.notify_row_written(
        db, dormitory_id=dormitory_id, table_key="inflow", row_id=plan.source.id, actor_id=user.id
    )
    notification_rules.notify_row_written(
        db,
        dormitory_id=dormitory_id,
        table_key="residents" if action == "settle" else "outflow",
        row_id=target.id,
        actor_id=user.id,
    )
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
    _dormitory: OwnDormitory,
) -> PersonnelInflow:
    require_section_writable(db, dormitory_id, "inflow")
    row = get_inflow(db, dormitory_id, row_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    record_changed(db, row, _user.id)
    db.commit()
    db.refresh(row)
    notification_rules.notify_row_written(
        db, dormitory_id=dormitory_id, table_key="inflow", row_id=row.id, actor_id=_user.id
    )
    return row


@router.delete(
    "/{row_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить строку притока"
)
def delete_inflow(
    dormitory_id: DormitoryId,
    row_id: InflowId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> None:
    require_section_writable(db, dormitory_id, "inflow")
    lock_dormitory(db, dormitory_id)
    row = get_inflow(db, dormitory_id, row_id)
    if row.processed_as:
        raise HTTPException(409, "Строка притока уже обработана. Действия по ней недоступны")
    record_changed(db, row, _user.id, kind="deleted", title="Удалена исходная запись притока")
    db.delete(row)
    db.commit()
