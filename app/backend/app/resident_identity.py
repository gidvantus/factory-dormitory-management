"""Выбранные столбцы формы заселения: отдельно для каждого общежития."""

from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.personnel import PersonnelBinding
from app.models.resident import Resident
from app.models.table_column import TableColumn
from app.schemas.resident import UpdateResidentRequest
from app.table_data import ensure_columns, normalize_value, require_column_type_change

ENTRY_ROLES = ("full_name", "phone")
ROLE_NAMES = {"full_name": "ФИО", "phone": "Телефон"}


def entry_fields(db: Session, dormitory_id: int, columns: list[TableColumn]) -> dict[str, int]:
    binding = db.scalar(
        select(PersonnelBinding).where(
            PersonnelBinding.dormitory_id == dormitory_id,
            PersonnelBinding.table_key == "residents",
        )
    )
    if binding is not None:
        return {field: column for field, column in binding.fields.items() if field in ENTRY_ROLES}
    return {
        role: column.id
        for role in ENTRY_ROLES
        for column in columns
        if column.builtin_key == role
        and not column.archived
        and not column.fill
        and column.kind == "text"
    }


def compatible(column: TableColumn, role: str) -> bool:
    return (
        not column.archived
        and not column.fill
        and column.kind == "text"
        and column.builtin_key in (None, role)
    )


def identity_value(role: str, value: Any) -> str | None:
    try:
        return getattr(UpdateResidentRequest.model_validate({role: value}), role)
    except ValidationError as exc:
        raise HTTPException(422, f"Проверьте значение поля «{ROLE_NAMES[role]}»") from exc


def checked_entry_fields(
    db: Session,
    dormitory_id: int,
    values: dict[str, Any],
    expected: dict[str, int] | None = None,
) -> tuple[dict[str, int], dict[int, TableColumn]]:
    columns = ensure_columns(db, dormitory_id, "residents")
    fields = entry_fields(db, dormitory_id, columns)
    if expected is not None and expected != fields:
        raise HTTPException(409, "Столбцы для ФИО и телефона изменились. Обновите настройки формы.")
    by_id = {column.id: column for column in columns}
    for role in ENTRY_ROLES:
        if values.get(role) is None:
            continue
        column = by_id.get(fields.get(role, 0))
        if column is None or not compatible(column, role):
            raise HTTPException(
                409,
                f"Выберите действующий текстовый столбец для поля «{ROLE_NAMES[role]}» "
                "в настройках добавления строки",
            )
    return fields, by_id


def write_entry_identity(
    db: Session,
    row: Resident,
    roles: set[str],
    expected: dict[str, int] | None = None,
) -> None:
    values = {role: getattr(row, role) for role in ENTRY_ROLES if role in roles}
    fields, columns = checked_entry_fields(db, row.dormitory_id, values, expected)
    custom = dict(row.custom_values or {})
    for role, value in values.items():
        column = columns.get(fields.get(role, 0))
        if column is not None and compatible(column, role) and not column.builtin_key:
            custom[str(column.id)] = normalize_value(column, value)
    row.custom_values = custom


def sync_identity_cell(db: Session, row: Resident, column: TableColumn, value: Any) -> Any:
    fields = entry_fields(db, row.dormitory_id, ensure_columns(db, row.dormitory_id, "residents"))
    for role in ENTRY_ROLES:
        if fields.get(role) == column.id:
            value = identity_value(role, value)
            setattr(row, role, value)
    return value


def save_entry_fields(
    db: Session,
    dormitory_id: int,
    fields: dict[str, int],
    convert_phone: bool,
) -> list[Resident]:
    if set(fields) - set(ENTRY_ROLES) or len(set(fields.values())) != len(fields):
        raise HTTPException(422, "Выберите разные столбцы для ФИО и телефона")
    columns = {column.id: column for column in ensure_columns(db, dormitory_id, "residents")}
    for role, column_id in fields.items():
        column = columns.get(column_id)
        if (
            column is not None
            and role == "phone"
            and column.kind == "number"
            and not column.archived
            and not column.builtin_key
            and convert_phone
        ):
            require_column_type_change(db, column, "text")
            column.kind = "text"
            column.options = []
        if column is None or not compatible(column, role):
            raise HTTPException(422, "Выберите ручные текстовые столбцы этой таблицы")
    binding = db.scalar(
        select(PersonnelBinding).where(
            PersonnelBinding.dormitory_id == dormitory_id,
            PersonnelBinding.table_key == "residents",
        )
    ) or PersonnelBinding(dormitory_id=dormitory_id, table_key="residents")
    binding.fields = dict(fields)
    db.add(binding)
    changed: list[Resident] = []
    for row in db.scalars(select(Resident).where(Resident.dormitory_id == dormitory_id)):
        custom = dict(row.custom_values or {})
        dirty = False
        for role, column_id in fields.items():
            column = columns[column_id]
            if column.builtin_key:
                continue
            key = str(column_id)
            value = custom.get(key)
            # Уже заполненные ячейки сохраняются. В пустые возвращаются сведения
            # из записи, в том числе введённые до настройки назначения столбцов.
            if value is None or value == "":
                value = getattr(row, role)
            value = identity_value(role, value)
            if custom.get(key) != value or getattr(row, role) != value:
                dirty = True
                custom[key] = value
                setattr(row, role, value)
        if dirty:
            row.custom_values = custom
            changed.append(row)
    db.flush()
    return changed
