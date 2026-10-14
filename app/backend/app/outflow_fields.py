"""Поля переноса и единый список причин из настроек таблицы «Отток»."""

from datetime import date
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.outflow import PersonnelOutflow
from app.models.outflow_reason import OutflowReason
from app.models.table_column import TableColumn
from app.resident_payments import normalized_name
from app.schemas.outflow import OutflowFields, ReasonChoice
from app.schemas.table_column import ColumnResponse
from app.table_data import ensure_columns, record_value


def field_columns(columns: list[TableColumn]) -> tuple[TableColumn | None, TableColumn | None]:
    active = [column for column in columns if not column.archived]
    # A configured custom dropdown takes precedence over the standard text field.
    reasons = [
        column
        for column in active
        if column.kind in ("text", "select")
        and (
            column.builtin_key == "reason"
            or (not column.builtin_key and normalized_name(column.name) in ("причина", "причины"))
        )
    ]
    reasons.sort(
        key=lambda column: (
            column.kind != "select",
            column.builtin_key != "reason",
            column.position,
        )
    )
    dates = [
        column
        for column in active
        if column.kind == "date"
        and (
            column.builtin_key == "departure_date"
            or (
                not column.builtin_key
                and normalized_name(column.name) in ("дата выезда", "дата оттока")
            )
        )
    ]
    dates.sort(key=lambda column: (column.builtin_key != "departure_date", column.position))
    return reasons[0] if reasons else None, dates[0] if dates else None


def outflow_fields(
    db: Session, dormitory_id: int, columns: list[TableColumn] | None = None
) -> OutflowFields:
    reason, departure = field_columns(
        columns if columns is not None else ensure_columns(db, dormitory_id, "outflow")
    )
    choices: list[ReasonChoice] = []
    if reason and reason.kind == "select":
        choices = [
            ReasonChoice(value=option["id"], label=option["label"])
            for option in reason.options
            if not option["archived"]
        ]
    elif reason:
        labels = [
            item.label
            for item in db.scalars(
                select(OutflowReason)
                .where(OutflowReason.column_id == reason.id)
                .order_by(OutflowReason.id)
            )
        ]
        labels.extend(
            value
            for row in db.scalars(
                select(PersonnelOutflow)
                .where(PersonnelOutflow.dormitory_id == dormitory_id)
                .order_by(PersonnelOutflow.id)
            )
            if isinstance(value := record_value(row, reason), str) and value.strip()
        )
        unique: dict[str, str] = {}
        for label in labels:
            unique.setdefault(" ".join(label.split()).casefold(), label)
        choices = [ReasonChoice(value=label, label=label) for label in unique.values()]
    return OutflowFields(
        reason_column=ColumnResponse.model_validate(reason) if reason else None,
        departure_column=ColumnResponse.model_validate(departure) if departure else None,
        reasons=choices,
    )


def remember_reason(db: Session, column: TableColumn, value: str) -> str:
    label = " ".join(value.split())
    if not label or len(label) > 255 or "\x00" in label:
        raise HTTPException(422, "Укажите причину оттока длиной до 255 символов")
    normalized = label.casefold()
    existing = db.scalar(
        select(OutflowReason).where(
            OutflowReason.column_id == column.id, OutflowReason.normalized == normalized
        )
    )
    if existing:
        return existing.label
    for row in db.scalars(
        select(PersonnelOutflow)
        .where(PersonnelOutflow.dormitory_id == column.dormitory_id)
        .order_by(PersonnelOutflow.id)
    ):
        old = record_value(row, column)
        if isinstance(old, str) and normalized_name(old) == normalized:
            label = old
            break
    db.add(
        OutflowReason(
            dormitory_id=column.dormitory_id,
            column_id=column.id,
            label=label,
            normalized=normalized,
        )
    )
    return label


def apply_outflow_fields(
    db: Session,
    dormitory_id: int,
    fields: dict[str, Any],
    custom: dict[str, Any],
    values: dict[str, Any],
) -> None:
    reason, departure = field_columns(ensure_columns(db, dormitory_id, "outflow"))
    if "reason" in values:
        if reason is None:
            raise HTTPException(409, "Столбец причины недоступен. Повторно проверьте отток")
        raw = values["reason"]
        if not raw:
            raise HTTPException(422, "Укажите причину оттока")
        if reason.kind == "select":
            option = next(
                (
                    option
                    for option in reason.options
                    if option["id"] == raw and not option["archived"]
                ),
                None,
            )
            if option is None:
                raise HTTPException(422, "Выберите действующую причину из списка «Отток»")
            stored, label = option["id"], option["label"]
        else:
            stored = label = remember_reason(db, reason, raw)
        fields["reason"] = label
        if not reason.builtin_key:
            custom[str(reason.id)] = stored
    if "departure_date" in values:
        if departure is None:
            raise HTTPException(409, "Столбец даты выезда недоступен. Повторно проверьте отток")
        if values["departure_date"] is None:
            raise HTTPException(422, "Укажите дату оттока")
        fields["departure_date"] = values["departure_date"]
        if not departure.builtin_key:
            custom[str(departure.id)] = values["departure_date"].isoformat()


def sync_outflow_cell(db: Session, row: PersonnelOutflow, column: TableColumn, value: Any) -> Any:
    reason, departure = field_columns(ensure_columns(db, row.dormitory_id, "outflow"))
    if reason and column.id == reason.id:
        if value is None:
            row.reason = None
        elif reason.kind == "text":
            value = row.reason = remember_reason(db, reason, value)
        else:
            row.reason = next(option["label"] for option in reason.options if option["id"] == value)
    if departure and column.id == departure.id:
        row.departure_date = date.fromisoformat(value) if value else None
    return value
