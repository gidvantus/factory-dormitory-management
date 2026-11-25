"""Копирование текущих совместимых столбцов проживающего в список выплат."""

from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.payment import PaymentEntry
from app.models.resident import Resident
from app.schemas.payment import PaymentKind, UpdatePaymentRequest
from app.schemas.transfer_columns import TransferColumnChoice
from app.table_data import ensure_columns, record_value
from app.transfer_columns import TransferColumns, matching_value, normalized_name


def copy_payment_values(
    db: Session, dormitory_id: int, resident: Resident, kind: PaymentKind, *, check_columns: bool
) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str], list[TransferColumnChoice]]:
    sources = ensure_columns(db, dormitory_id, "residents")
    targets = ensure_columns(db, dormitory_id, kind)
    mapping = TransferColumns(db, sources, targets)
    fields: dict[str, Any] = {}
    custom: dict[str, Any] = {}
    copied: list[str] = []
    skipped: list[str] = []
    copied_sources: set[int] = set()
    occupied: set[int] = set()
    for target in targets:
        if target.archived or target.kind not in ("text", "number", "date", "checkbox", "select"):
            continue
        matches = [
            source
            for source in sources
            if not source.archived
            and source.kind == target.kind
            and (
                mapping.reserved.get(target.id) == source.id
                or (
                    target.id not in mapping.reserved
                    and source.id not in mapping.explicit
                    and normalized_name(source.name) == normalized_name(target.name)
                )
            )
        ]
        if len(matches) != 1:
            continue
        source = matches[0]
        if record_value(resident, source) is None:
            continue
        try:
            value = matching_value(source, target, resident)
            if value is None:
                continue
            if target.builtin_key:
                # Пользовательский столбец может совпасть со стандартным полем:
                # применяем ограничения длины, суммы и даты стандартного редактора.
                validated = UpdatePaymentRequest.model_validate({target.builtin_key: value})
                fields[target.builtin_key] = getattr(validated, target.builtin_key)
            else:
                custom[str(target.id)] = value
            copied.append(target.name)
            copied_sources.add(source.id)
            occupied.add(target.id)
        except (HTTPException, ValidationError):
            skipped.append(target.name)
    choices = (
        mapping.choices(
            resident, copied=copied_sources, occupied=occupied, schema=UpdatePaymentRequest
        )
        if check_columns
        else []
    )
    return fields, custom, copied, skipped, choices


def existing_payment(
    db: Session, dormitory_id: int, resident_id: int, kind: PaymentKind, fields: dict[str, Any]
) -> PaymentEntry | None:
    conditions = [PaymentEntry.source_resident_id == resident_id]
    # Учитываем также строки, ранее добавленные вручную по тому же табельному номеру.
    if personnel_number := fields.get("personnel_number"):
        conditions.append(
            func.lower(func.trim(PaymentEntry.personnel_number)) == personnel_number.lower()
        )
    return db.scalar(
        select(PaymentEntry)
        .where(
            PaymentEntry.dormitory_id == dormitory_id,
            PaymentEntry.kind == kind,
            or_(*conditions),
        )
        .order_by(PaymentEntry.id)
    )
