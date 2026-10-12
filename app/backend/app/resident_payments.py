"""Копирование текущих совместимых столбцов проживающего в список выплат."""

from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.payment import PaymentEntry
from app.models.resident import Resident
from app.models.table_column import TableColumn
from app.schemas.payment import PaymentKind, UpdatePaymentRequest
from app.table_data import ensure_columns, normalize_value, record_value


def normalized_name(value: str) -> str:
    return " ".join(value.split()).casefold()


def matching_value(source: TableColumn, target: TableColumn, resident: Resident) -> Any:
    value = record_value(resident, source)
    if value is None:
        return None
    if target.kind == "select":
        option = next((item for item in source.options if item["id"] == value), None)
        if option is None or option["archived"]:
            raise HTTPException(422, "Вариант исходного списка недоступен")
        matches = [
            item
            for item in target.options
            if not item["archived"]
            and normalized_name(item["label"]) == normalized_name(option["label"])
        ]
        if len(matches) != 1:
            raise HTTPException(422, "Вариант не найден в списке выплат")
        value = matches[0]["id"]
    return normalize_value(target, value)


def copy_payment_values(
    db: Session, dormitory_id: int, resident: Resident, kind: PaymentKind
) -> tuple[dict[str, Any], dict[str, Any], list[str], list[str]]:
    sources = ensure_columns(db, dormitory_id, "residents")
    targets = ensure_columns(db, dormitory_id, kind)
    fields: dict[str, Any] = {}
    custom: dict[str, Any] = {}
    copied: list[str] = []
    skipped: list[str] = []
    for target in targets:
        if target.archived or target.kind not in ("text", "number", "date", "checkbox", "select"):
            continue
        matches = [
            source
            for source in sources
            if not source.archived
            and source.kind == target.kind
            and normalized_name(source.name) == normalized_name(target.name)
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
        except (HTTPException, ValidationError):
            skipped.append(target.name)
    return fields, custom, copied, skipped


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
