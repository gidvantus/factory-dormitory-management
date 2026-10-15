"""Подтверждённое выселение завершает проживание, сохраняя строку оттока."""

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.resident import Resident
from app.personnel import digest, group_ids, identity_lock
from app.schemas.outflow import OutflowEvictionPreview
from app.section_state import require_section_writable
from app.table_data import lock_dormitory


@dataclass
class EvictionPlan:
    row: PersonnelOutflow
    residents: list[Resident]
    payments: list[PaymentEntry]
    preview: OutflowEvictionPreview


def prepare_eviction(db: Session, dormitory_id: int, row_id: int) -> EvictionPlan:
    lock_dormitory(db, dormitory_id)
    require_section_writable(db, dormitory_id, "outflow")
    identity_lock(db)
    row = db.scalar(
        select(PersonnelOutflow)
        .where(PersonnelOutflow.id == row_id, PersonnelOutflow.dormitory_id == dormitory_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise HTTPException(404, "Строка оттока не найдена")
    if row.evicted_at:
        raise HTTPException(409, "Сотрудник уже выселен. Действия по этой строке недоступны")
    if not row.employee_id:
        raise HTTPException(422, "Сначала укажите сотрудника в строке оттока")
    ids = group_ids(db, row.employee_id)
    residents = list(
        db.scalars(
            select(Resident)
            .where(Resident.dormitory_id == dormitory_id, Resident.employee_id.in_(ids))
            .order_by(Resident.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    if residents:
        require_section_writable(db, dormitory_id, "residents")
    if row.departure_date and any(
        resident.shift_start and resident.shift_start > row.departure_date for resident in residents
    ):
        raise HTTPException(409, "Сотрудник заселён повторно после этой записи оттока")

    # Выплаты связаны с конкретным проживанием. Для старых ручных строк допустим
    # табельный номер, только если у другого проживающего этого номера нет.
    numbers = {
        resident.personnel_number.strip().lower()
        for resident in residents
        if resident.personnel_number and resident.personnel_number.strip()
    }
    if numbers:
        conflicting = db.scalars(
            select(Resident.personnel_number).where(
                Resident.dormitory_id == dormitory_id,
                Resident.id.not_in([resident.id for resident in residents]),
                func.lower(func.trim(Resident.personnel_number)).in_(numbers),
            )
        )
        numbers -= {number.strip().lower() for number in conflicting if number}
    payments = list(
        db.scalars(
            select(PaymentEntry)
            .where(
                PaymentEntry.dormitory_id == dormitory_id,
                PaymentEntry.kind.in_(("advance", "settlement")),
                or_(
                    PaymentEntry.source_resident_id.in_([resident.id for resident in residents]),
                    and_(
                        PaymentEntry.source_resident_id.is_(None),
                        func.lower(func.trim(PaymentEntry.personnel_number)).in_(numbers),
                    ),
                ),
            )
            .order_by(PaymentEntry.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    for kind in {payment.kind for payment in payments}:
        require_section_writable(db, dormitory_id, kind)

    def snapshot(item: PersonnelOutflow | Resident | PaymentEntry) -> dict[str, Any]:
        return {column.key: getattr(item, column.key) for column in item.__table__.columns}

    token = digest(
        {
            "outflow": snapshot(row),
            "residents": [snapshot(resident) for resident in residents],
            "payments": [snapshot(payment) for payment in payments],
        }
    )
    return EvictionPlan(row, residents, payments, OutflowEvictionPreview(preview_token=token))
