"""Перенос в отток и удаление выплат по подтверждённому снимку данных."""

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models.payment import PaymentEntry
from app.models.resident import Resident
from app.resident_payments import matching_value, normalized_name
from app.schemas.outflow import UpdateOutflowRequest
from app.schemas.resident import UpdateResidentRequest
from app.schemas.resident_outflow import ResidentOutflowPreview
from app.schemas.resident_transfer import TransferWarning
from app.schemas.table_column import ColumnResponse
from app.table_data import ensure_columns, lock_dormitory


@dataclass
class OutflowPlan:
    resident: Resident
    fields: dict[str, Any]
    custom: dict[str, Any]
    payments: list[PaymentEntry]
    preview: ResidentOutflowPreview


def prepare_outflow(db: Session, dormitory_id: int, resident_id: int) -> OutflowPlan:
    lock_dormitory(db, dormitory_id)
    resident = db.scalar(
        select(Resident)
        .where(Resident.id == resident_id, Resident.dormitory_id == dormitory_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if resident is None:
        raise HTTPException(404, "Проживающий не найден")
    sources = ensure_columns(db, dormitory_id, "residents")
    targets = ensure_columns(db, dormitory_id, "outflow")
    fields: dict[str, Any] = {}
    custom: dict[str, Any] = {}
    matched: list[str] = []
    warnings: list[TransferWarning] = []
    used: set[int] = set()
    for source in sources:
        if source.kind == "action":
            continue
        raw = (
            getattr(resident, source.builtin_key, None)
            if source.builtin_key
            else resident.custom_values.get(str(source.id))
        )
        reason = ""
        if source.archived:
            if raw is None or raw == "":
                continue
            reason = "Столбец удалён в исходной таблице"
        matches = [
            col
            for col in targets
            if not col.archived and normalized_name(col.name) == normalized_name(source.name)
        ]
        if not reason:
            if not matches:
                reason = "В таблице «Отток» нет этого столбца"
            elif (
                len(matches) != 1
                or sum(
                    not col.archived and normalized_name(col.name) == normalized_name(source.name)
                    for col in sources
                )
                != 1
            ):
                reason = "Совпадение названий неоднозначно"
            elif source.kind != matches[0].kind:
                reason = "В таблице «Отток» другой тип столбца"
        if reason:
            warnings.append(TransferWarning(column=source.name, reason=reason))
            continue
        target = matches[0]
        try:
            value = matching_value(source, target, resident)
            if target.builtin_key:
                validated = UpdateOutflowRequest.model_validate({target.builtin_key: value})
                fields[target.builtin_key] = getattr(validated, target.builtin_key)
            elif value is not None:
                custom[str(target.id)] = value
            used.add(target.id)
            matched.append(source.name)
        except HTTPException as caught:
            reason = str(caught.detail)
            if target.kind == "select":
                reason = "Вариант недоступен в исходном списке или в списке «Отток»"
            warnings.append(TransferWarning(column=source.name, reason=reason))
        except ValidationError:
            warnings.append(
                TransferWarning(
                    column=source.name, reason="Значение не подходит для столбца «Отток»"
                )
            )

    conditions = [PaymentEntry.source_resident_id == resident_id]
    # Ручные записи сопоставляем только по табельному номеру; ФИО не уникально.
    if number := resident.personnel_number:
        conditions.append(
            and_(
                PaymentEntry.source_resident_id.is_(None),
                func.lower(func.trim(PaymentEntry.personnel_number)) == number.strip().lower(),
            )
        )
    payments = list(
        db.scalars(
            select(PaymentEntry)
            .where(
                PaymentEntry.dormitory_id == dormitory_id,
                PaymentEntry.kind.in_(("advance", "settlement")),
                or_(*conditions),
            )
            .order_by(PaymentEntry.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    snapshot = {
        "dormitory": dormitory_id,
        "resident_id": resident_id,
        "resident": {key: getattr(resident, key) for key in UpdateResidentRequest.model_fields},
        "custom_values": resident.custom_values,
        "sources": [ColumnResponse.model_validate(col).model_dump() for col in sources],
        "targets": [ColumnResponse.model_validate(col).model_dump() for col in targets],
        "fields": fields,
        "custom": custom,
        "payments": [
            {col.key: getattr(payment, col.key) for col in PaymentEntry.__table__.columns}
            for payment in payments
        ],
    }
    token = hashlib.sha256(
        json.dumps(snapshot, ensure_ascii=False, sort_keys=True, default=str).encode()
    ).hexdigest()
    return OutflowPlan(
        resident=resident,
        fields=fields,
        custom=custom,
        payments=payments,
        preview=ResidentOutflowPreview(
            matched_columns=matched,
            warnings=warnings,
            empty_columns=[
                col.name
                for col in targets
                if not col.archived and col.kind != "action" and col.id not in used
            ],
            departure_date=fields.get("departure_date"),
            payments_to_delete={
                kind: sum(payment.kind == kind for payment in payments)
                for kind in ("advance", "settlement")
            },
            preview_token=token,
        ),
    )
