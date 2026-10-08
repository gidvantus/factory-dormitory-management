"""Перевод по текущей структуре таблиц с проверкой подтверждённого снимка."""

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.hostel import Hostel
from app.models.resident import Resident
from app.resident_payments import matching_value, normalized_name
from app.schemas.resident import UpdateResidentRequest
from app.schemas.resident_transfer import TransferPreviewResponse, TransferWarning
from app.schemas.table_column import ColumnResponse
from app.table_data import ensure_columns, lock_dormitory


@dataclass
class TransferPlan:
    resident: Resident
    fields: dict[str, Any]
    custom: dict[str, Any]
    preview: TransferPreviewResponse


def hostel_value(db: Session, resident: Resident, target_id: int, month: date) -> int | None:
    if resident.hostel_id is None:
        return None
    source = db.get(Hostel, resident.hostel_id)
    hostels = db.scalars(
        select(Hostel)
        .where(
            Hostel.dormitory_id == target_id,
            Hostel.active_from_month <= month,
            or_(Hostel.active_until_month.is_(None), Hostel.active_until_month > month),
        )
        .with_for_update()
    )
    matches = [
        hostel
        for hostel in hostels
        if source is not None and normalized_name(hostel.name) == normalized_name(source.name)
    ]
    if len(matches) != 1:
        raise HTTPException(422, "В новом общежитии нет действующего хостела с таким названием")
    return matches[0].id


def prepare_transfer(
    db: Session, source_id: int, resident_id: int, target_id: int, month: date
) -> TransferPlan:
    if source_id == target_id:
        raise HTTPException(422, "Выберите другое общежитие")
    # Единый порядок замков исключает взаимную блокировку встречных переводов.
    for dormitory_id in sorted((source_id, target_id)):
        lock_dormitory(db, dormitory_id)
    target_dormitory = db.get(Dormitory, target_id)
    assert target_dormitory is not None
    if target_dormitory.is_archived:
        raise HTTPException(409, "Нельзя перевести в архивное общежитие. Сначала восстановите его")
    resident = db.scalar(
        select(Resident)
        .where(Resident.id == resident_id, Resident.dormitory_id == source_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if resident is None:
        raise HTTPException(404, "Проживающий не найден в исходном общежитии")
    sources = ensure_columns(db, source_id, "residents")
    targets = ensure_columns(db, target_id, "residents")
    fields: dict[str, Any] = {}
    custom: dict[str, Any] = {}
    matched: list[str] = []
    warnings: list[TransferWarning] = []
    used: set[int] = set()
    for source in sources:
        if source.kind == "action":
            continue
        raw_value = (
            getattr(resident, source.builtin_key, None)
            if source.builtin_key
            else resident.custom_values.get(str(source.id))
        )
        if source.archived:
            if raw_value is not None and raw_value != "":
                warnings.append(
                    TransferWarning(column=source.name, reason="Столбец удалён в исходной таблице")
                )
            continue
        matches = [
            col
            for col in targets
            if not col.archived and normalized_name(col.name) == normalized_name(source.name)
        ]
        if not matches:
            warnings.append(
                TransferWarning(column=source.name, reason="В новом общежитии нет этого столбца")
            )
            continue
        if (
            len(matches) != 1
            or sum(
                not col.archived and normalized_name(col.name) == normalized_name(source.name)
                for col in sources
            )
            != 1
        ):
            warnings.append(
                TransferWarning(column=source.name, reason="Совпадение названий неоднозначно")
            )
            continue
        target = matches[0]
        if source.kind != target.kind:
            warnings.append(
                TransferWarning(column=source.name, reason="В новом общежитии другой тип столбца")
            )
            continue
        try:
            value = (
                hostel_value(db, resident, target_id, month)
                if source.kind == "hostel"
                else matching_value(source, target, resident)
            )
            if target.builtin_key:
                validated = UpdateResidentRequest.model_validate({target.builtin_key: value})
                fields[target.builtin_key] = getattr(validated, target.builtin_key)
            elif value is not None:
                custom[str(target.id)] = value
            used.add(target.id)
            matched.append(source.name)
        except HTTPException as caught:
            warnings.append(TransferWarning(column=source.name, reason=str(caught.detail)))
        except ValidationError:
            warnings.append(
                TransferWarning(
                    column=source.name, reason="Значение не подходит для нового столбца"
                )
            )
    if (
        fields.get("shift_start") is not None
        and fields.get("shift_end") is not None
        and fields["shift_end"] < fields["shift_start"]
    ):
        for key in ("shift_start", "shift_end"):
            col = next(col for col in targets if col.builtin_key == key)
            fields.pop(key)
            used.discard(col.id)
            if col.name in matched:
                matched.remove(col.name)
            warnings.append(TransferWarning(column=col.name, reason="Конец вахты раньше начала"))
    empty = [
        col.name
        for col in targets
        if not col.archived and col.kind != "action" and col.id not in used
    ]
    if (number := fields.get("personnel_number")) and (
        db.scalar(
            select(Resident.id).where(
                Resident.dormitory_id == target_id,
                func.lower(func.trim(Resident.personnel_number)) == number.lower(),
            )
        )
        is not None
    ):
        raise HTTPException(409, "В новом общежитии уже есть проживающий с этим Т/н")
    snapshot = {
        "source": source_id,
        "resident_id": resident_id,
        "target": target_id,
        "month": month,
        "resident": {key: getattr(resident, key) for key in UpdateResidentRequest.model_fields},
        "custom_values": resident.custom_values,
        "sources": [ColumnResponse.model_validate(col).model_dump() for col in sources],
        "targets": [ColumnResponse.model_validate(col).model_dump() for col in targets],
        "fields": fields,
        "custom": custom,
        "warnings": [warning.model_dump() for warning in warnings],
    }
    token = hashlib.sha256(
        json.dumps(snapshot, ensure_ascii=False, sort_keys=True, default=str).encode()
    ).hexdigest()
    return TransferPlan(
        resident=resident,
        fields=fields,
        custom=custom,
        preview=TransferPreviewResponse(
            target_dormitory_id=target_id,
            matched_columns=matched,
            warnings=warnings,
            empty_columns=empty,
            preview_token=token,
        ),
    )
