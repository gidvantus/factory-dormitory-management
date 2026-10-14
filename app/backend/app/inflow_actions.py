"""Приток остаётся журналом; результат создаётся из совпадающих активных столбцов."""

from dataclasses import dataclass
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.inflow import PersonnelInflow
from app.outflow_fields import outflow_fields
from app.personnel import digest
from app.resident_payments import matching_value, normalized_name
from app.schemas.inflow import InflowActionPreview, UpdateInflowRequest
from app.schemas.outflow import UpdateOutflowRequest
from app.schemas.resident import UpdateResidentRequest
from app.schemas.resident_transfer import TransferWarning
from app.schemas.table_column import ColumnResponse
from app.section_state import require_section_writable
from app.table_data import ensure_columns, lock_dormitory

InflowAction = Literal["settle", "outflow"]


@dataclass
class InflowPlan:
    source: PersonnelInflow
    fields: dict[str, Any]
    custom: dict[str, Any]
    preview: InflowActionPreview


def prepare_inflow_action(
    db: Session, dormitory_id: int, row_id: int, action: InflowAction
) -> InflowPlan:
    lock_dormitory(db, dormitory_id)
    destination: Literal["residents", "outflow"] = "residents" if action == "settle" else "outflow"
    require_section_writable(db, dormitory_id, "inflow")
    require_section_writable(db, dormitory_id, destination)
    row = db.scalar(
        select(PersonnelInflow)
        .where(PersonnelInflow.id == row_id, PersonnelInflow.dormitory_id == dormitory_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise HTTPException(404, "Строка притока не найдена")
    if row.processed_as:
        raise HTTPException(409, "Эта строка притока уже обработана. Обновите список")
    sources = ensure_columns(db, dormitory_id, "inflow")
    targets = ensure_columns(db, dormitory_id, destination)
    fields: dict[str, Any] = {}
    custom: dict[str, Any] = {}
    matched: list[str] = []
    warnings: list[TransferWarning] = []
    used: set[int] = set()
    title = "Проживающие" if action == "settle" else "Отток"
    schema = UpdateResidentRequest if action == "settle" else UpdateOutflowRequest
    for source in sources:
        if source.archived or source.kind == "action":
            continue
        matches = [
            col
            for col in targets
            if not col.archived and normalized_name(col.name) == normalized_name(source.name)
        ]
        reason = ""
        if not matches:
            reason = f"В таблице «{title}» нет этого столбца"
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
            reason = "Типы столбцов отличаются"
        if reason:
            warnings.append(TransferWarning(column=source.name, reason=reason))
            continue
        target = matches[0]
        try:
            value = matching_value(source, target, row)
            if target.builtin_key:
                validated = schema.model_validate({target.builtin_key: value})
                fields[target.builtin_key] = getattr(validated, target.builtin_key)
            elif value is not None:
                custom[str(target.id)] = value
            used.add(target.id)
            matched.append(source.name)
        except (HTTPException, ValidationError):
            warnings.append(
                TransferWarning(
                    column=source.name, reason="Значение не подходит для столбца назначения"
                )
            )
    if (
        fields.get("shift_start")
        and fields.get("shift_end")
        and fields["shift_end"] < fields["shift_start"]
    ):
        raise HTTPException(422, "Конец вахты раньше начала. Исправьте даты в притоке")
    # Место проживания не выводится из даты заселения; оно переносится лишь при совпадении столбцов.
    token = digest(
        {
            "dormitory": dormitory_id,
            "source_id": row_id,
            "action": action,
            "employee_id": row.employee_id,
            "source": {key: getattr(row, key) for key in UpdateInflowRequest.model_fields},
            "custom_values": row.custom_values,
            "sources": [ColumnResponse.model_validate(col).model_dump() for col in sources],
            "targets": [ColumnResponse.model_validate(col).model_dump() for col in targets],
            "fields": fields,
            "custom": custom,
        }
    )
    return InflowPlan(
        row,
        fields,
        custom,
        InflowActionPreview(
            destination=destination,
            preview_token=token,
            matched_columns=matched,
            warnings=warnings,
            empty_columns=[
                col.name
                for col in targets
                if not col.archived and col.kind != "action" and col.id not in used
            ],
            fields=outflow_fields(db, dormitory_id, targets) if action == "outflow" else None,
            departure_date=fields.get("departure_date"),
        ),
    )
