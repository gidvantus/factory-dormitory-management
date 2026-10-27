"""Записи на аванс и расчёт по общежитию."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser
from app.db import get_db
from app.models.payment import PaymentEntry
from app.schemas.payment import PaymentKind, PaymentResponse, UpdatePaymentRequest
from app.section_state import require_section_writable
from app.table_data import lock_dormitory

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/payments",
    tags=["payments"],
    responses={**SUBSCRIBED_USER_RESPONSES},
)
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]
PaymentId = Annotated[int, Path(ge=1, le=2147483647)]


def get_payment(db: Session, dormitory_id: int, kind: PaymentKind, row_id: int) -> PaymentEntry:
    row = db.get(PaymentEntry, row_id)
    if row is None or row.dormitory_id != dormitory_id or row.kind != kind:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Строка выплаты не найдена")
    return row


@router.get("/{kind}", response_model=list[PaymentResponse], summary="Список на аванс или расчёт")
def list_payments(
    dormitory_id: DormitoryId,
    kind: PaymentKind,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
) -> list[PaymentEntry]:
    query = select(PaymentEntry).where(
        PaymentEntry.dormitory_id == dormitory_id, PaymentEntry.kind == kind
    )
    if kind == "settlement":
        if (
            from_date is None
            or to_date is None
            or from_date > to_date
            or (to_date - from_date).days > 365
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Выберите период не длиннее года"
            )
        query = query.where(
            or_(
                PaymentEntry.settlement_date.is_(None),
                PaymentEntry.settlement_date.between(from_date, to_date),
            )
        )
    return list(db.scalars(query.order_by(PaymentEntry.id)))


@router.post(
    "/{kind}",
    response_model=PaymentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить строку выплаты",
)
def create_payment(
    dormitory_id: DormitoryId,
    kind: PaymentKind,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> PaymentEntry:
    require_section_writable(db, dormitory_id, kind)
    lock_dormitory(db, dormitory_id)
    row = PaymentEntry(dormitory_id=dormitory_id, kind=kind)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch(
    "/{kind}/{row_id}", response_model=PaymentResponse, summary="Сохранить строку выплаты"
)
def update_payment(
    dormitory_id: DormitoryId,
    kind: PaymentKind,
    row_id: PaymentId,
    payload: UpdatePaymentRequest,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> PaymentEntry:
    require_section_writable(db, dormitory_id, kind)
    lock_dormitory(db, dormitory_id)
    row = get_payment(db, dormitory_id, kind, row_id)
    changes = payload.model_dump(exclude_unset=True)
    if kind == "advance" and "settlement_date" in changes:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Дата расчёта недоступна для аванса"
        )
    if kind == "settlement" and "advance_amount" in changes:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Сумма аванса недоступна для расчёта"
        )
    for field, value in changes.items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete(
    "/{kind}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Очистить весь список аванса или расчёта",
)
def clear_payments(
    dormitory_id: DormitoryId,
    kind: PaymentKind,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> None:
    require_section_writable(db, dormitory_id, kind)
    lock_dormitory(db, dormitory_id)
    db.execute(
        delete(PaymentEntry).where(
            PaymentEntry.dormitory_id == dormitory_id, PaymentEntry.kind == kind
        )
    )
    db.commit()


@router.delete(
    "/{kind}/{row_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Удалить строку выплаты"
)
def delete_payment(
    dormitory_id: DormitoryId,
    kind: PaymentKind,
    row_id: PaymentId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> None:
    require_section_writable(db, dormitory_id, kind)
    lock_dormitory(db, dormitory_id)
    db.delete(get_payment(db, dormitory_id, kind, row_id))
    db.commit()
