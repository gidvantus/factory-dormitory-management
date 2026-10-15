"""Форма притока по текущим столбцам проживающих и сохранение будущего заселения."""

from datetime import date
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.hostel import Hostel
from app.models.inflow import PersonnelInflow
from app.models.resident import Resident
from app.models.table_column import TableColumn
from app.personnel import digest
from app.resident_payments import matching_value, normalized_name
from app.schemas.inflow import InflowEntryForm, UpdateInflowRequest
from app.schemas.resident import HostelOption, UpdateResidentRequest
from app.schemas.table_column import ColumnResponse
from app.table_data import ensure_columns, normalize_value


def entry_form(db: Session, dormitory_id: int, month: date) -> InflowEntryForm:
    if month.day != 1:
        raise HTTPException(422, "Укажите первый день месяца")
    source = ensure_columns(db, dormitory_id, "inflow")
    target = ensure_columns(db, dormitory_id, "residents")
    hostels = [
        HostelOption(id=item.id, name=item.name)
        for item in db.scalars(
            select(Hostel)
            .where(
                Hostel.dormitory_id == dormitory_id,
                Hostel.active_from_month <= month,
                or_(Hostel.active_until_month.is_(None), Hostel.active_until_month > month),
            )
            .order_by(Hostel.name, Hostel.id)
        )
    ]
    token = digest(
        {
            "dormitory": dormitory_id,
            "month": month,
            "inflow": [ColumnResponse.model_validate(col).model_dump() for col in source],
            "residents": [ColumnResponse.model_validate(col).model_dump() for col in target],
            "hostels": [hostel.model_dump() for hostel in hostels],
        }
    )
    return InflowEntryForm(
        columns=[
            ColumnResponse.model_validate(col)
            for col in target
            if not col.archived and col.kind != "action"
        ],
        hostels=hostels,
        month=month,
        schema_token=token,
    )


def resident_cell(column: TableColumn, value: Any, hostel_ids: set[int]) -> Any:
    try:
        if column.kind == "hostel":
            validated = UpdateResidentRequest.model_validate({"hostel_id": value or None})
            if validated.hostel_id is not None and validated.hostel_id not in hostel_ids:
                raise HTTPException(422, "Выберите действующее место проживания")
            return validated.hostel_id
        value = normalize_value(column, value)
        if column.builtin_key:
            validated = UpdateResidentRequest.model_validate({column.builtin_key: value})
            return validated.model_dump(mode="json")[column.builtin_key]
        return value
    except (HTTPException, ValidationError) as exc:
        detail = exc.detail if isinstance(exc, HTTPException) else "Проверьте формат значения"
        raise HTTPException(422, f"{column.name}: {detail}") from exc


def resident_data(
    columns: list[TableColumn], values: dict[str, Any], hostel_ids: set[int]
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    available = {str(col.id): col for col in columns if not col.archived and col.kind != "action"}
    if values.keys() - available.keys():
        raise HTTPException(409, "Столбцы изменились. Проверьте форму ещё раз")
    fields: dict[str, Any] = {}
    custom: dict[str, Any] = {}
    saved: dict[str, Any] = {}
    for key, column in available.items():
        value = resident_cell(column, values.get(key), hostel_ids)
        if column.builtin_key:
            fields[column.builtin_key] = value
        else:
            custom[key] = value
        saved[key] = {"kind": column.kind, "value": value}
    validated = UpdateResidentRequest.model_validate(fields)
    if (
        validated.shift_start
        and validated.shift_end
        and validated.shift_end < validated.shift_start
    ):
        raise HTTPException(422, "Конец вахты раньше начала")
    return validated.model_dump(exclude_unset=True), custom, saved


def copy_entry_to_inflow(
    resident: Resident, source: list[TableColumn], target: list[TableColumn]
) -> tuple[dict[str, Any], dict[str, Any]]:
    fields: dict[str, Any] = {}
    custom: dict[str, Any] = {}
    for column in target:
        if column.archived or column.kind == "action":
            continue
        matches = [
            item
            for item in source
            if not item.archived
            and item.kind == column.kind
            and normalized_name(item.name) == normalized_name(column.name)
        ]
        if len(matches) != 1:
            continue
        try:
            value = matching_value(matches[0], column, resident)
            if column.builtin_key:
                parsed = UpdateInflowRequest.model_validate({column.builtin_key: value})
                fields[column.builtin_key] = getattr(parsed, column.builtin_key)
            else:
                custom[str(column.id)] = value
        except (HTTPException, ValidationError):
            continue
    return fields, custom


def saved_resident_data(
    db: Session, row: PersonnelInflow, columns: list[TableColumn]
) -> tuple[dict[str, Any], dict[str, Any]]:
    stored = row.resident_values or {}
    values = stored.get("columns", {})
    if not values:
        return {}, {}
    month = date.fromisoformat(stored["month"])
    hostels = {hostel.id for hostel in entry_form(db, row.dormitory_id, month).hostels}
    fields: dict[str, Any] = {}
    custom: dict[str, Any] = {}
    for column in columns:
        cell = values.get(str(column.id))
        if column.archived or column.kind == "action" or not cell or cell["kind"] != column.kind:
            continue
        try:
            value = resident_cell(column, cell["value"], hostels)
        except HTTPException:
            # Удалённые варианты и закрытые места не восстанавливаем при заселении.
            continue
        if column.builtin_key:
            fields[column.builtin_key] = value
        else:
            custom[str(column.id)] = value
    return UpdateResidentRequest.model_validate(fields).model_dump(exclude_unset=True), custom
