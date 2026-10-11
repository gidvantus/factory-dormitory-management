"""Рабочая поверхность персонала и подтверждаемое связывание записей."""

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.custom_tab import CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.personnel import (
    Employee,
    EmployeeDecision,
    EmployeeEvent,
    EmployeeMerge,
    EmployeeNote,
    EmployeePlan,
    EmployeeSeparation,
    EmployeeTask,
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
    event,
    fulfill_arrival,
    get_employee,
    group_ids,
    identity_lock,
    pair_signature,
    record_changed,
    today,
    workspace,
)
from app.schemas.inflow import UpdateInflowRequest
from app.schemas.outflow import UpdateOutflowRequest
from app.schemas.personnel import (
    BindingInput,
    DecisionInput,
    EmployeeUpdate,
    IdentityFields,
    MergeInput,
    NoteInput,
    PlanInput,
    PlanUpdate,
    PreferencesInput,
    RecordCreate,
    RecordLink,
    TaskInput,
    TaskUpdate,
)
from app.schemas.resident import UpdateResidentRequest
from app.schemas.table_column import TableKey
from app.security import ACTIVE_USER_RESPONSES, ActiveUser
from app.table_data import (
    ensure_columns,
    get_record,
    lock_dormitory,
    normalize_value,
    require_writable_table,
)

router = APIRouter(prefix="/personnel", tags=["personnel"], responses=ACTIVE_USER_RESPONSES)
DbSession = Annotated[Session, Depends(get_db)]


@router.get("")
def get_workspace(user: ActiveUser, db: DbSession) -> dict[str, Any]:
    return workspace(db, user)


@router.post("/check")
def check(payload: IdentityFields, _user: ActiveUser, db: DbSession) -> dict[str, Any]:
    return check_identity(db, payload)


@router.post("/records", status_code=201)
def create_record(payload: RecordCreate, user: ActiveUser, db: DbSession) -> dict[str, Any]:
    lock_dormitory(db, payload.dormitory_id)
    require_writable_table(db, payload.dormitory_id, payload.table_key)
    columns = ensure_columns(db, payload.dormitory_id, payload.table_key)
    identity_lock(db)
    employee = choose_identity(db, payload.identity)
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
    return {"row_id": row.id, "employee_id": employee.id}


@router.post("/link")
def link_record(payload: RecordLink, user: ActiveUser, db: DbSession) -> dict[str, Any]:
    lock_dormitory(db, payload.dormitory_id)
    require_writable_table(db, payload.dormitory_id, payload.table_key)
    identity_lock(db)
    row = get_record(db, payload.dormitory_id, payload.table_key, payload.row_id)
    if not isinstance(
        row, (Resident, PersonnelInflow, PersonnelOutflow, CustomTabEntry, ArchiveEntry)
    ):
        raise HTTPException(422, "Эта таблица не содержит записей персонала")
    employee = choose_identity(db, payload.identity)
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
    if isinstance(row, Resident):
        decision = db.get(EmployeeDecision, row.id)
        if decision:
            decision.employee_id = employee.id
            plan = db.get(EmployeePlan, decision.plan_id) if decision.plan_id else None
            if plan:
                plan.employee_id = employee.id
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
def detail(employee_id: UUID, _user: ActiveUser, db: DbSession) -> dict[str, Any]:
    return employee_detail(db, str(employee_id))


@router.patch("/employees/{employee_id}")
def update_employee(
    employee_id: UUID, payload: EmployeeUpdate, user: ActiveUser, db: DbSession
) -> dict[str, bool]:
    identity_lock(db)
    item = get_employee(db, str(employee_id))
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


@router.post("/employees/{employee_id}/tasks", status_code=201)
def add_task(
    employee_id: UUID, payload: TaskInput, user: ActiveUser, db: DbSession
) -> dict[str, bool]:
    identity_lock(db)
    employee = get_employee(db, str(employee_id))
    if payload.assignee_id:
        assignee = db.get(User, payload.assignee_id)
        if assignee is None or not assignee.is_active:
            raise HTTPException(422, "Выберите действующего ответственного")
    db.add(EmployeeTask(employee_id=employee.id, created_by_id=user.id, **payload.model_dump()))
    event(
        db,
        employee.id,
        "task",
        f"Добавлена задача: {payload.text}",
        user.id,
        snapshot=payload.model_dump(mode="json"),
    )
    db.commit()
    return {"ok": True}


@router.patch("/tasks/{task_id}")
def update_task(
    task_id: UUID, payload: TaskUpdate, user: ActiveUser, db: DbSession
) -> dict[str, bool]:
    identity_lock(db)
    task = db.get(EmployeeTask, str(task_id))
    if task is None:
        raise HTTPException(404, "Задача не найдена")
    if task.done != payload.done:
        task.done = payload.done
        event(
            db,
            task.employee_id,
            "task",
            f"{'Выполнена' if task.done else 'Возвращена в работу'} задача: {task.text}",
            user.id,
        )
    db.commit()
    return {"ok": True}


@router.post("/employees/{employee_id}/notes", status_code=201)
def add_note(
    employee_id: UUID, payload: NoteInput, user: ActiveUser, db: DbSession
) -> dict[str, bool]:
    identity_lock(db)
    employee = get_employee(db, str(employee_id))
    db.add(EmployeeNote(employee_id=employee.id, author_id=user.id, text=payload.text))
    event(db, employee.id, "note", "Добавлена заметка", user.id, snapshot={"text": payload.text})
    db.commit()
    return {"ok": True}


@router.put("/employees/{employee_id}/next-shift")
def save_next_shift(
    employee_id: UUID, payload: PlanInput, user: ActiveUser, db: DbSession
) -> dict[str, bool]:
    lock_dormitory(db, payload.dormitory_id)
    identity_lock(db)
    employee = get_employee(db, str(employee_id))
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
    plan_id: UUID, payload: PlanUpdate, user: ActiveUser, db: DbSession
) -> dict[str, bool]:
    identity_lock(db)
    plan = db.get(EmployeePlan, str(plan_id))
    if plan is None:
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
def cancel_plan(plan_id: UUID, user: ActiveUser, db: DbSession) -> None:
    identity_lock(db)
    plan = db.get(EmployeePlan, str(plan_id))
    if plan is None:
        raise HTTPException(404, "План не найден")
    for decision in db.scalars(select(EmployeeDecision).where(EmployeeDecision.plan_id == plan.id)):
        decision.status, decision.date, decision.plan_id = "waiting", None, None
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


@router.put("/employees/{employee_id}/decision")
def save_decision(
    employee_id: UUID, payload: DecisionInput, user: ActiveUser, db: DbSession
) -> dict[str, bool]:
    resident = db.get(Resident, payload.resident_id)
    if resident is None:
        raise HTTPException(404, "Запись проживания не найдена")
    lock_dormitory(db, resident.dormitory_id)
    require_writable_table(db, resident.dormitory_id, "residents")
    identity_lock(db)
    employee = get_employee(db, str(employee_id))
    if resident.employee_id not in group_ids(db, employee.id):
        raise HTTPException(409, "Запись проживания относится к другому сотруднику")
    decision = db.get(EmployeeDecision, resident.id)
    if not decision:
        decision = EmployeeDecision(
            resident_id=resident.id,
            employee_id=resident.employee_id,
            original_end=resident.shift_end,
            status="waiting",
        )
        db.add(decision)
    if payload.status != "waiting" and payload.date and payload.date < today():
        raise HTTPException(422, "Укажите сегодняшнюю или будущую дату")
    if payload.status == "extend":
        if (
            payload.date is None
            or (resident.shift_start and payload.date < resident.shift_start)
            or (decision.original_end and payload.date <= decision.original_end)
        ):
            raise HTTPException(422, "Продление должно быть позже первоначального окончания вахты")
        next_plans = list(
            db.scalars(
                select(EmployeePlan).where(
                    EmployeePlan.employee_id.in_(group_ids(db, employee.id)),
                    EmployeePlan.kind == "arrival",
                )
            )
        )
        if any(plan.date <= payload.date for plan in next_plans):
            raise HTTPException(
                409, "Продление пересекается со следующим заездом. Сначала измените план приезда"
            )
        resident.shift_end = payload.date
        record_changed(
            db, resident, user.id, kind="shift", title="Согласовано продление текущей вахты"
        )
    old_plan = db.get(EmployeePlan, decision.plan_id) if decision.plan_id else None
    if payload.status == "departure":
        assert payload.date is not None
        plan = old_plan or EmployeePlan(
            employee_id=resident.employee_id,
            kind="departure",
            dormitory_id=resident.dormitory_id,
            created_by_id=user.id,
        )
        plan.date, plan.end, plan.comment, plan.confirmed = (
            payload.date,
            None,
            payload.comment,
            True,
        )
        plan.dormitory_id = resident.dormitory_id
        db.add(plan)
        db.flush()
        decision.plan_id = plan.id
    elif old_plan:
        decision.plan_id = None
        db.delete(old_plan)
    decision.status, decision.date, decision.comment = payload.status, payload.date, payload.comment
    event(
        db,
        resident.employee_id,
        "decision",
        {
            "waiting": "Ожидаем решение по вахте",
            "extend": "Продление согласовано",
            "departure": "Согласован выезд",
        }[payload.status],
        user.id,
        dormitory_id=resident.dormitory_id,
        source_table="residents",
        source_id=resident.id,
        snapshot=payload.model_dump(mode="json"),
    )
    db.commit()
    return {"ok": True}


def validate_pair(db: Session, payload: MergeInput) -> tuple[Employee, Employee]:
    identity_lock(db)
    source, target = (
        get_employee(db, str(payload.source_id)),
        get_employee(db, str(payload.target_id)),
    )
    if source.id == target.id:
        raise HTTPException(409, "Записи уже относятся к одной карточке")
    if pair_signature(db, source.id, target.id) != payload.signature:
        raise HTTPException(409, "Данные карточек изменились. Повторите сравнение")
    return source, target


@router.post("/merge")
def merge(payload: MergeInput, user: ActiveUser, db: DbSession) -> dict[str, Any]:
    source, target = validate_pair(db, payload)
    source.merged_into_id = target.id
    target.identity_status = "confirmed"
    operation = EmployeeMerge(
        source_id=source.id, target_id=target.id, reason=payload.reason, actor_id=user.id
    )
    db.add(operation)
    db.flush()
    event(
        db,
        source.id,
        "identity",
        "Карточки связаны в общую историю",
        user.id,
        snapshot={
            "merge_id": operation.id,
            "source_id": source.id,
            "target_id": target.id,
            "reason": payload.reason,
        },
    )
    db.commit()
    return {"employee_id": target.id, "merge_id": operation.id}


@router.post("/separate")
def separate(payload: MergeInput, user: ActiveUser, db: DbSession) -> dict[str, bool]:
    source, target = validate_pair(db, payload)
    pair = ":".join(sorted((source.id, target.id)))
    separation = db.get(EmployeeSeparation, pair) or EmployeeSeparation(pair=pair)
    separation.signature, separation.reason, separation.actor_id = (
        payload.signature,
        payload.reason,
        user.id,
    )
    db.add(separation)
    for item, other in ((source, target), (target, source)):
        event(
            db,
            item.id,
            "identity",
            "Совпадение проверено: разные сотрудники",
            user.id,
            snapshot={"other_id": other.id, "reason": payload.reason},
        )
    db.commit()
    return {"ok": True}


@router.post("/merges/{merge_id}/undo")
def undo_merge(merge_id: UUID, user: ActiveUser, db: DbSession) -> dict[str, bool]:
    identity_lock(db)
    operation = db.get(EmployeeMerge, str(merge_id))
    if operation is None:
        raise HTTPException(404, "Операция объединения не найдена")
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
def preferences(payload: PreferencesInput, user: ActiveUser, db: DbSession) -> dict[str, Any]:
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
    dormitory_id: int, table_key: TableKey, _user: ActiveUser, db: DbSession
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
    dormitory_id: int, table_key: TableKey, payload: BindingInput, user: ActiveUser, db: DbSession
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
