"""Рабочая поверхность персонала и подтверждаемое связывание записей."""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notification_rules
from app.access import (
    SUBSCRIBED_USER_RESPONSES,
    OwnDormitory,
    SubscribedUser,
    own_dormitory,
    scoped_dormitories,
)
from app.api.organization import Membership
from app.db import get_db
from app.models.custom_tab import CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.personnel import (
    Employee,
    EmployeeEvent,
    EmployeeMerge,
    EmployeeNote,
    EmployeePlan,
    PersonnelBinding,
    PersonnelPreferences,
)
from app.models.resident import Resident
from app.models.table_column import ArchiveEntry
from app.models.user import User
from app.personnel import (
    IDENTITY_FIELDS,
    Row,
    add_aliases,
    check_identity,
    choose_identity,
    employee_detail,
    employee_in_scope,
    event,
    fulfill_arrival,
    get_employee,
    group_ids,
    identity_lock,
    record_changed,
    today,
    workspace,
)
from app.schemas.inflow import UpdateInflowRequest
from app.schemas.outflow import UpdateOutflowRequest
from app.schemas.personnel import (
    BindingInput,
    EmployeeUpdate,
    IdentityFields,
    NoteInput,
    PlanInput,
    PlanUpdate,
    PreferencesInput,
    RecordCreate,
    RecordLink,
)
from app.schemas.resident import UpdateResidentRequest
from app.schemas.table_column import TableKey
from app.table_data import (
    ensure_columns,
    get_record,
    lock_dormitory,
    normalize_value,
    require_writable_table,
)

router = APIRouter(prefix="/personnel", tags=["personnel"], responses=SUBSCRIBED_USER_RESPONSES)
DbSession = Annotated[Session, Depends(get_db)]


def dormitory_scope(db: Session, membership: Membership) -> list[int]:
    """`id` общежитий организации — область для выборок «по всем общежитиям».

    Само правило принадлежности живёт в `app.access.scoped_dormitories`; здесь
    только его проекция на `id` для функций домена, которым нужен список.
    """
    return [item.id for item in scoped_dormitories(db, membership.organization_id)]


@router.get("")
def get_workspace(user: SubscribedUser, membership: Membership, db: DbSession) -> dict[str, Any]:
    return workspace(db, user, dormitory_scope(db, membership))


@router.post("/check")
def check(
    payload: IdentityFields, _user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    return check_identity(db, payload, dormitory_scope(db, membership))


@router.post("/records", status_code=201)
def create_record(
    payload: RecordCreate,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    # Права проверяются раньше блокировки: чужое общежитие не блокируется.
    own_dormitory(db, payload.dormitory_id, membership)
    lock_dormitory(db, payload.dormitory_id)
    require_writable_table(db, payload.dormitory_id, payload.table_key)
    columns = ensure_columns(db, payload.dormitory_id, payload.table_key)
    identity_lock(db)
    employee = choose_identity(db, payload.identity, dormitory_scope(db, membership))
    values = dict(payload.values)
    schemas: dict[str, type[BaseModel]] = {
        "residents": UpdateResidentRequest,
        "inflow": UpdateInflowRequest,
        "outflow": UpdateOutflowRequest,
    }
    schema = schemas.get(payload.table_key)
    if schema:
        for field in IDENTITY_FIELDS:
            if field in schema.model_fields:
                values.setdefault(
                    field, getattr(payload.identity, field) or getattr(employee, field)
                )
        try:
            fields = schema.model_validate(values).model_dump(exclude_unset=True)
        except ValidationError as exc:
            raise HTTPException(422, "Проверьте данные сотрудника и формат телефона") from exc
        if (
            fields.get("shift_start")
            and fields.get("shift_end")
            and fields["shift_end"] < fields["shift_start"]
        ):
            raise HTTPException(422, "Конец вахты раньше начала")
        if payload.table_key == "residents" and fields.get("hostel_id"):
            # Место выбирается в самой таблице с её проверкой действующего месяца.
            raise HTTPException(422, "Выберите место проживания после добавления сотрудника")
        models: dict[str, type[Row]] = {
            "residents": Resident,
            "inflow": PersonnelInflow,
            "outflow": PersonnelOutflow,
        }
        model = models[payload.table_key]
        row: Row = model(dormitory_id=payload.dormitory_id, employee_id=employee.id, **fields)
    else:
        if values:
            raise HTTPException(422, "Дополнительные ячейки заполняются в исходной таблице")
        custom: dict[str, Any] = {}
        binding = db.scalar(
            select(PersonnelBinding).where(
                PersonnelBinding.dormitory_id == payload.dormitory_id,
                PersonnelBinding.table_key == payload.table_key,
            )
        )
        if binding:
            available = {col.id: col for col in columns if not col.archived}
            for field, column_id in binding.fields.items():
                if column_id in available and field in IDENTITY_FIELDS:
                    value = getattr(payload.identity, field) or getattr(employee, field)
                    custom[str(column_id)] = normalize_value(available[column_id], value)
        row = (
            CustomTabEntry(
                dormitory_id=payload.dormitory_id,
                tab_id=int(payload.table_key[7:]),
                employee_id=employee.id,
                custom_values=custom,
            )
            if payload.table_key.startswith("custom_")
            else ArchiveEntry(
                dormitory_id=payload.dormitory_id, employee_id=employee.id, custom_values=custom
            )
        )
    db.add(row)
    db.flush()
    record_changed(db, row, user.id)
    if isinstance(row, Resident):
        fulfill_arrival(db, row, user.id)
    event(
        db,
        employee.id,
        "identity",
        "Выбрана существующая карточка"
        if payload.identity.mode == "existing"
        else "Личность требует проверки"
        if payload.identity.mode == "pending"
        else "Создана карточка сотрудника",
        user.id,
        dormitory_id=row.dormitory_id,
        source_table=payload.table_key,
        source_id=row.id,
        snapshot={"choice": payload.identity.mode},
    )
    db.commit()
    # «Кадры» — второй писатель таблиц каталога: `create_record` создаёт строку
    # «Архива», пользовательской вкладки, «Проживающих», «Притока» и «Оттока».
    # Правило обязано срабатывать и здесь, а не только на кнопке «+».
    notification_rules.notify_row_written(
        db,
        dormitory_id=row.dormitory_id,
        table_key=payload.table_key,
        row_id=row.id,
        actor_id=user.id,
    )
    return {"row_id": row.id, "employee_id": employee.id}


@router.post("/link")
def link_record(
    payload: RecordLink,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    own_dormitory(db, payload.dormitory_id, membership)
    lock_dormitory(db, payload.dormitory_id)
    require_writable_table(db, payload.dormitory_id, payload.table_key)
    identity_lock(db)
    row = get_record(db, payload.dormitory_id, payload.table_key, payload.row_id)
    if not isinstance(
        row, (Resident, PersonnelInflow, PersonnelOutflow, CustomTabEntry, ArchiveEntry)
    ):
        raise HTTPException(422, "Эта таблица не содержит записей персонала")
    employee = choose_identity(db, payload.identity, dormitory_scope(db, membership))
    old_id = row.employee_id
    if old_id and get_employee(db, old_id).id == employee.id:
        db.commit()
        return {"employee_id": employee.id}
    previous = list(
        db.scalars(
            select(EmployeeEvent).where(
                EmployeeEvent.source_table == payload.table_key, EmployeeEvent.source_id == row.id
            )
        )
    )
    for entry in previous:
        entry.employee_id = employee.id
    row.employee_id = employee.id
    record_changed(db, row, user.id, kind="identity", title="Запись связана с карточкой сотрудника")
    event(
        db,
        employee.id,
        "identity",
        "Изменена связь исходной записи",
        user.id,
        dormitory_id=row.dormitory_id,
        source_table=payload.table_key,
        source_id=row.id,
        snapshot={
            "previous_employee_id": old_id,
            "employee_id": employee.id,
            "choice": payload.identity.mode,
        },
    )
    db.commit()
    return {"employee_id": employee.id}


@router.get("/employees/{employee_id}")
def detail(
    employee_id: UUID,
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    employee_in_scope(db, str(employee_id), dormitory_scope(db, membership))
    return employee_detail(db, str(employee_id))


@router.patch("/employees/{employee_id}")
def update_employee(
    employee_id: UUID,
    payload: EmployeeUpdate,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, bool]:
    identity_lock(db)
    item = employee_in_scope(db, str(employee_id), dormitory_scope(db, membership))
    before = {field: getattr(item, field) for field in IDENTITY_FIELDS}
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    add_aliases(db, item.id, {field: getattr(item, field) for field in IDENTITY_FIELDS})
    event(
        db,
        item.id,
        "identity",
        "Уточнены данные карточки сотрудника",
        user.id,
        snapshot={"before": before, "after": payload.model_dump()},
    )
    db.commit()
    return {"ok": True}


@router.post("/employees/{employee_id}/notes", status_code=201)
def add_note(
    employee_id: UUID,
    payload: NoteInput,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, bool]:
    identity_lock(db)
    employee = employee_in_scope(db, str(employee_id), dormitory_scope(db, membership))
    db.add(EmployeeNote(employee_id=employee.id, author_id=user.id, text=payload.text))
    event(db, employee.id, "note", "Добавлена заметка", user.id, snapshot={"text": payload.text})
    db.commit()
    return {"ok": True}


@router.put("/employees/{employee_id}/next-shift")
def save_next_shift(
    employee_id: UUID,
    payload: PlanInput,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, bool]:
    own_dormitory(db, payload.dormitory_id, membership)
    lock_dormitory(db, payload.dormitory_id)
    identity_lock(db)
    employee = employee_in_scope(db, str(employee_id), dormitory_scope(db, membership))
    dormitory = db.get(Dormitory, payload.dormitory_id)
    if dormitory is None or dormitory.is_archived:
        raise HTTPException(422, "Выберите действующее общежитие")
    ids = group_ids(db, employee.id)
    ends = list(
        db.scalars(
            select(Resident.shift_end).where(
                Resident.employee_id.in_(ids), Resident.shift_end.is_not(None)
            )
        )
    )
    earliest = max([today(), *[end + timedelta(days=1) for end in ends if end is not None]])
    if payload.date < earliest:
        raise HTTPException(
            422, "Следующая вахта должна начинаться после текущей и не раньше сегодняшнего дня"
        )
    plans = list(
        db.scalars(
            select(EmployeePlan).where(
                EmployeePlan.employee_id.in_(ids), EmployeePlan.kind == "arrival"
            )
        )
    )
    if len(plans) > 1:
        raise HTTPException(
            409, "После объединения осталось несколько планов. Отмените лишние перед изменением"
        )
    plan = (
        plans[0]
        if plans
        else EmployeePlan(employee_id=employee.id, kind="arrival", created_by_id=user.id)
    )
    for field, value in payload.model_dump().items():
        setattr(plan, field, value)
    db.add(plan)
    event(
        db,
        plan.employee_id,
        "plan",
        "Запланирована следующая вахта",
        user.id,
        dormitory_id=plan.dormitory_id,
        snapshot=payload.model_dump(mode="json"),
    )
    db.commit()
    return {"ok": True}


@router.patch("/plans/{plan_id}")
def confirm_plan(
    plan_id: UUID,
    payload: PlanUpdate,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, bool]:
    identity_lock(db)
    plan = db.get(EmployeePlan, str(plan_id))
    if plan is None or plan.dormitory_id not in dormitory_scope(db, membership):
        raise HTTPException(404, "План не найден")
    if plan.confirmed != payload.confirmed:
        plan.confirmed = payload.confirmed
        event(
            db,
            plan.employee_id,
            "plan",
            "План подтверждён" if plan.confirmed else "Снято подтверждение плана",
            user.id,
            dormitory_id=plan.dormitory_id,
        )
    db.commit()
    return {"ok": True}


@router.delete("/plans/{plan_id}", status_code=204)
def cancel_plan(plan_id: UUID, user: SubscribedUser, membership: Membership, db: DbSession) -> None:
    identity_lock(db)
    plan = db.get(EmployeePlan, str(plan_id))
    if plan is None or plan.dormitory_id not in dormitory_scope(db, membership):
        raise HTTPException(404, "План не найден")
    event(
        db,
        plan.employee_id,
        "plan",
        "План отменён",
        user.id,
        dormitory_id=plan.dormitory_id,
        snapshot={"kind": plan.kind, "date": plan.date.isoformat(), "comment": plan.comment},
    )
    db.delete(plan)
    db.commit()


@router.post("/merges/{merge_id}/undo")
def undo_merge(
    merge_id: UUID,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, bool]:
    identity_lock(db)
    operation = db.get(EmployeeMerge, str(merge_id))
    if operation is None:
        raise HTTPException(404, "Операция объединения не найдена")
    # Объединение касается карточек, у которых нет своей организации: проверяем,
    # что хотя бы одна из них видна в общежитиях организации из сессии.
    employee_in_scope(db, operation.source_id, dormitory_scope(db, membership))
    if operation.undone_at:
        raise HTTPException(409, "Объединение уже отменено")
    source = db.get(Employee, operation.source_id)
    if source is None or source.merged_into_id != operation.target_id:
        raise HTTPException(409, "Связь карточек изменилась. Обновите страницу")
    source.merged_into_id = None
    operation.undone_at, operation.undone_by_id = datetime.now(UTC), user.id
    for id in (operation.source_id, operation.target_id):
        event(
            db,
            id,
            "identity",
            "Отменено объединение карточек",
            user.id,
            snapshot={"merge_id": operation.id},
        )
    db.commit()
    return {"ok": True}


@router.put("/preferences")
def preferences(payload: PreferencesInput, user: SubscribedUser, db: DbSession) -> dict[str, Any]:
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    item = db.get(PersonnelPreferences, user.id)
    if (item.revision if item else 0) != payload.revision:
        raise HTTPException(
            409, "Настройки изменены в другом окне. Обновите страницу перед сохранением"
        )
    if not item:
        item = PersonnelPreferences(user_id=user.id, revision=0)
        db.add(item)
    item.settings = payload.model_dump(mode="json", exclude={"revision"})
    item.revision += 1
    db.commit()
    return {"revision": item.revision, **item.settings}


@router.get("/bindings/{dormitory_id}/{table_key}")
def get_binding(
    dormitory_id: int,
    table_key: TableKey,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> dict[str, Any]:
    columns = ensure_columns(db, dormitory_id, table_key)
    item = db.scalar(
        select(PersonnelBinding).where(
            PersonnelBinding.dormitory_id == dormitory_id, PersonnelBinding.table_key == table_key
        )
    )
    db.commit()
    return {
        "fields": item.fields if item else {},
        "columns": [
            {"id": c.id, "name": c.name, "kind": c.kind, "builtin_key": c.builtin_key}
            for c in columns
            if not c.archived and c.kind != "action"
        ],
    }


@router.put("/bindings/{dormitory_id}/{table_key}")
def save_binding(
    dormitory_id: int,
    table_key: TableKey,
    payload: BindingInput,
    user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> dict[str, bool]:
    if not (table_key.startswith("custom_") or table_key == "archive"):
        raise HTTPException(422, "Основные таблицы уже связаны по встроенным полям")
    lock_dormitory(db, dormitory_id)
    require_writable_table(db, dormitory_id, table_key)
    columns = {
        c.id: c
        for c in ensure_columns(db, dormitory_id, table_key)
        if not c.archived and not c.builtin_key
    }
    if len(set(payload.fields.values())) != len(payload.fields):
        raise HTTPException(422, "Один столбец нельзя назначить нескольким полям")
    for field, column_id in payload.fields.items():
        col = columns.get(column_id)
        kinds = (
            ("date",)
            if field.startswith("shift_")
            else ("text", "number")
            if field == "personnel_number"
            else ("text",)
        )
        if col is None or col.kind not in kinds:
            raise HTTPException(422, "Выберите столбцы подходящего типа из этой таблицы")
    item = db.scalar(
        select(PersonnelBinding).where(
            PersonnelBinding.dormitory_id == dormitory_id, PersonnelBinding.table_key == table_key
        )
    ) or PersonnelBinding(dormitory_id=dormitory_id, table_key=table_key)
    item.fields = {str(field): column_id for field, column_id in payload.fields.items()}
    db.add(item)
    db.flush()
    binding_model: type[CustomTabEntry | ArchiveEntry] = (
        CustomTabEntry if table_key.startswith("custom_") else ArchiveEntry
    )
    rows = select(binding_model).where(binding_model.dormitory_id == dormitory_id)
    if binding_model is CustomTabEntry:
        rows = rows.where(CustomTabEntry.tab_id == int(table_key[7:]))
    for row in db.scalars(rows):
        record_changed(
            db,
            cast(Row, row),
            user.id,
            kind="source",
            title="Настроено сопоставление полей таблицы",
        )
    db.commit()
    return {"ok": True}
