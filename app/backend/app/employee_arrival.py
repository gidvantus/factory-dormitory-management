"""Подстановка данных карточки в действующие поля плана заездов."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.arrival_settings import defaults, filled, missing_required, validate_field_value
from app.models.arrival_plan import ArrivalPlan, ArrivalSettings
from app.models.personnel import Employee
from app.models.resident import Resident
from app.models.table_column import TableColumn
from app.personnel import IDENTITY_FIELDS, normalized, source_key, source_rows
from app.schemas.arrival_settings import ArrivalField
from app.schemas.personnel import EmployeeArrivalInput
from app.table_data import record_value

FIELD_ALIASES = {
    "табельный номер": "personnel_number",
    "т н": "personnel_number",
    "телефон": "phone",
    "номер телефона": "phone",
    "номер телефона сотрудника": "phone",
    "пол": "gender",
    "кол во смен": "shift_count",
    "количество смен": "shift_count",
    "начало вахты": "shift_start",
    "дата начала вахты": "shift_start",
    "конец вахты": "shift_end",
    "окончание вахты": "shift_end",
    "дата окончания вахты": "shift_end",
}


def value_for_field(field: ArrivalField, raw: Any) -> str | bool | None:
    if not filled(raw):
        return None
    if isinstance(raw, bool):
        value: str | bool = raw
    elif isinstance(raw, (str, int, float)):
        value = str(raw).strip()
    else:
        return None
    if field.type == "select" and isinstance(value, str) and value not in field.options:
        matches = [
            option
            for option in field.options
            if normalized("label", option) == normalized("label", value)
        ]
        if len(matches) != 1:
            return None
        value = matches[0]
    try:
        validate_field_value(field, value)
    except HTTPException:
        return None
    return value


def employee_arrival_values(
    db: Session,
    employee: Employee,
    member_ids: list[str],
    dormitory_ids: list[int],
    payload: EmployeeArrivalInput,
    config: ArrivalSettings | None,
    plan: ArrivalPlan | None,
) -> tuple[str, dict[str, Any], dict[str, Any], list[ArrivalField]]:
    sources = source_rows(db, dormitory_ids, member_ids)
    sources.sort(
        key=lambda item: (
            isinstance(item[0], Resident),
            item[0].dormitory_id == payload.dormitory_id,
            item[1]["created_at"],
            item[0].id,
        ),
        reverse=True,
    )
    members = db.scalars(select(Employee).where(Employee.id.in_(member_ids)).order_by(Employee.id))
    identities = [
        {field: getattr(item, field) for field in IDENTITY_FIELDS} for item in (employee, *members)
    ]
    identities.extend(values for _, values in sources)
    identity = {
        field: next((item[field] for item in identities if filled(item.get(field))), None)
        for field in IDENTITY_FIELDS
    }
    full_name = " ".join(str(identity["full_name"] or "").split())
    if not full_name or len(full_name) > 255 or "\x00" in full_name:
        raise HTTPException(422, "Заполните ФИО в карточке сотрудника")

    definitions = config.settings if config else defaults()
    fields = {
        raw["id"]: ArrivalField.model_validate(raw)
        for raw in definitions["fields"]
        if raw["inForm"]
    }
    columns: dict[tuple[int, str], list[TableColumn]] = {}
    if sources and fields:
        for column in db.scalars(
            select(TableColumn)
            .where(
                TableColumn.dormitory_id.in_({row.dormitory_id for row, _ in sources}),
                TableColumn.archived.is_(False),
                TableColumn.kind.not_in(("action", "hostel")),
            )
            .order_by(TableColumn.position, TableColumn.id)
        ):
            columns.setdefault((column.dormitory_id, column.table_key), []).append(column)

    def find_value(field: ArrivalField) -> str | bool | None:
        label = normalized("label", field.label)
        alias = FIELD_ALIASES.get(label)
        if (
            alias in ("personnel_number", "phone")
            and (candidate := value_for_field(field, identity[alias])) is not None
        ):
            return candidate
        for row, _ in sources:
            for column in columns.get((row.dormitory_id, source_key(row)), ()):
                if normalized("label", column.name) != label and not (
                    alias and column.builtin_key == alias
                ):
                    continue
                try:
                    raw_value = record_value(row, column)
                except HTTPException:
                    continue
                if column.kind == "select":
                    raw_value = next(
                        (
                            option["label"]
                            for option in column.options
                            if option["id"] == raw_value and not option["archived"]
                        ),
                        None,
                    )
                if (candidate := value_for_field(field, raw_value)) is not None:
                    return candidate
        return None

    common = dict(plan.custom_values or {}) if plan else {}
    personal: dict[str, Any] = {}
    shift_fields = [
        field for field in fields.values() if field.scope == "person" and field.type == "number"
    ]
    manual_shifts = next((field for field in shift_fields if field.id == "shifts"), None) or next(
        (
            field
            for field in shift_fields
            if FIELD_ALIASES.get(normalized("label", field.label)) == "shift_count"
        ),
        None,
    )
    for field in fields.values():
        if field is manual_shifts:
            continue
        destination = common if field.scope == "arrival" else personal
        if field.scope == "arrival" and plan and not missing_required(field, common.get(field.id)):
            continue
        auto = find_value(field)
        if auto is not None:
            destination[field.id] = auto
    for field_id, value in payload.values.items():
        target = fields.get(field_id)
        if target is None:
            raise HTTPException(422, "Поля плана изменились. Откройте действие заново.")
        validate_field_value(target, value)
        if target.scope == "person":
            personal[field_id] = value
        elif plan is None or missing_required(target, (plan.custom_values or {}).get(field_id)):
            common[field_id] = value

    missing = [
        field
        for field in fields.values()
        if missing_required(field, (common if field.scope == "arrival" else personal).get(field.id))
    ]
    return full_name, personal, common, missing
