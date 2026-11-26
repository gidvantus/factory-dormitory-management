"""Рабочая поверхность персонала и подтверждаемое связывание записей."""

import json
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notification_rules, personnel_page
from app.access import (
    OwnDormitory,
    SubscribedUser,
    own_dormitory,
    scoped_dormitories,
)
from app.api.organization import Membership
from app.arrival_settings import settings_response
from app.db import get_db
from app.employee_profile import load_profile
from app.finished_shifts import finished_shifts
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
    cards_by_ids,
    check_identity,
    choose_identity,
    dormitory_list,
    employee_detail,
    employee_in_scope,
    event,
    fulfill_arrival,
    get_employee,
    group_ids,
    identity_lock,
    page_selection,
    record_changed,
    source_columns_response,
    today,
    workspace,
    workspace_context,
)
from app.personnel_export import export_people
from app.resident_identity import (
    checked_entry_fields,
    entry_fields,
    save_entry_fields,
    write_entry_identity,
)
from app.role_permissions import EXCHANGE_USER_RESPONSES, ExportUser
from app.schemas.inflow import UpdateInflowRequest
from app.schemas.outflow import UpdateOutflowRequest
from app.schemas.personnel import (
    BindingInput,
    EmployeeColumnFilter,
    EmployeePage,
    EmployeeProfileLookup,
    EmployeeUpdate,
    FinishedShift,
    IdentityFields,
    ListFilter,
    NoteInput,
    PersonnelExportInput,
    PlanInput,
    PlanUpdate,
    PreferencesInput,
    RecordCreate,
    RecordLink,
)
from app.schemas.resident import UpdateResidentRequest
from app.schemas.table_column import TableKey
from app.sql_diagnostics import stage
from app.table_data import (
    column_type_change_reason,
    ensure_columns,
    get_record,
    lock_dormitory,
    normalize_value,
    read_columns,
    require_writable_table,
    validate_resident_gender,
)
from app.table_pagination import PageRequest, TablePage

router = APIRouter(prefix="/personnel", tags=["personnel"], responses=EXCHANGE_USER_RESPONSES)
DbSession = Annotated[Session, Depends(get_db)]


def dormitory_scope(db: Session, membership: Membership) -> list[int]:
    """`id` общежитий организации — область для выборок «по всем общежитиям».

    Само правило принадлежности живёт в `app.access.scoped_dormitories`; здесь
    только его проекция на `id` для функций домена, которым нужен список.
    """
    return [item.id for item in scoped_dormitories(db, membership.organization_id)]


def json_response(payload: Any) -> Response:
    """Ответ из готового JSON без `jsonable_encoder` (#247).

    Собирать рабочую поверхность в Python дешевле, чем отдавать её словарём:
    энкодер FastAPI на объёме 1 467 296 байт тратил около 157 мс против 13.9 мс
    у `json.dumps`. Поэтому в ответе только типы JSON (даты — строки
    `YYYY-MM-DD`), а `default=` здесь намеренно не передан: значение, которое не
    сериализуется, — ошибка данных, и её ловит `test_personnel_contract.py`.

    `stage("serialize")` (#251) делает сериализацию видимой в разбивке
    `slow_sql_request`: без неё время ответа уходило в «прочее», и было неясно,
    сколько стоит тело, а сколько — выборки. Разметка ничего не меняет.
    """
    with stage("serialize"):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return Response(content=body, media_type="application/json")


def column_rules(raw: str) -> tuple[personnel_page.ColumnRule, ...]:
    """`column_filters` — JSON-массив условий; разбор тот же, что у `SavedList`."""
    if not raw.strip():
        return ()
    try:
        values = TypeAdapter(list[EmployeeColumnFilter]).validate_json(raw)
    except ValidationError as error:
        raise HTTPException(
            status_code=422, detail="Некорректное условие фильтра по столбцам"
        ) from error
    return tuple(
        personnel_page.ColumnRule(value.field, value.operator, value.value) for value in values
    )


def period_bounds(start: date | None, end: date | None) -> tuple[str, str] | None:
    """Период панели персонала: обе границы или ни одной, «от» не позже «до»."""
    if start is None and end is None:
        return None
    if start is None or end is None:
        raise HTTPException(422, "Укажите обе даты периода")
    if start > end:
        raise HTTPException(422, "Дата «От» должна быть не позже даты «До»")
    return start.isoformat(), end.isoformat()


@router.get("", response_model=dict[str, Any])
def get_workspace(
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    employees: Annotated[Literal["full", "none"], Query()] = "full",
    dormitory: Annotated[int | None, Query(ge=1)] = None,
    days: Annotated[int, Query(ge=0, le=365)] = 5,
    period_from: Annotated[date | None, Query()] = None,
    period_to: Annotated[date | None, Query()] = None,
) -> Response:
    """Рабочая поверхность персонала.

    `employees=none` отдаёт рамку поверхности без карточек: страница людей приходит
    из `GET /api/personnel/employees`, а блоки — из `block_previews`, сводка — из
    `counts` (#247). `days` — тот же срок вахты, что у страницы: от него зависит
    число «Завершают вахту». Период (`period_from`/`period_to`) важнее срока и
    приходит из панели персонала. Умолчание `full` оставлено прежним, чтобы переход
    был пошаговым.
    """
    result = workspace(
        db,
        user,
        dormitory_scope(db, membership),
        include_employees=employees == "full",
        include_previews=employees == "none",
        preview_dormitory=dormitory,
        days=days,
        period=period_bounds(period_from, period_to),
    )
    # Настройки заездов — отдельный этап (#237): он читает свои таблицы, но
    # ответ отдаётся одной ручкой, и в событии это разные строки разбивки.
    with stage("settings"):
        result["arrival_settings"] = settings_response(db, membership.organization_id)
    return json_response(result)


@router.get("/employees", response_model=EmployeePage)
def employees_page(
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    filter: Annotated[ListFilter, Query()] = "all",
    dormitory: Annotated[int | None, Query(ge=1)] = None,
    scope: Annotated[list[int] | None, Query()] = None,
    days: Annotated[int, Query(ge=0, le=365)] = 5,
    period_from: Annotated[date | None, Query()] = None,
    period_to: Annotated[date | None, Query()] = None,
    query: Annotated[str, Query(max_length=255)] = "",
    column_filters: Annotated[str, Query(max_length=4000)] = "",
    page: Annotated[int, Query(ge=1)] = 1,
    per_page: Annotated[int, Query(ge=1, le=100)] = 20,
) -> Response:
    """Страница сотрудников с серверной фильтрацией — те же правила, что в браузере.

    Набор и порядок людей проверяются теми же правилами, что и клиентский
    `filterPeople`, но отбор и сортировка идут в SQL (#251): читаются только `id`
    отобранных корней, а карточки собираются лишь для `per_page` строк страницы.
    Срез страницы — в Python по уже отсортированному списку `id`: `LIMIT` в SQL не
    идёт, потому что рядом нужен `total` по тому же отбору.
    """
    ids = dormitory_scope(db, membership)
    context = workspace_context(db, ids)
    dormitories = dormitory_list(context)
    columns = source_columns_response(db, context) if column_filters.strip() else []
    criteria = personnel_page.ListCriteria(
        filter=filter,
        dormitory=dormitory,
        days=days,
        period=period_bounds(period_from, period_to),
        query=query,
        scope=tuple(scope or ()),
        column_filters=column_rules(column_filters),
    )
    selected, total = page_selection(
        db,
        context,
        criteria,
        day=today(),
        number=page,
        per_page=per_page,
        dormitories=dormitories,
        source_columns=columns,
    )
    items = cards_by_ids(db, context, selected)
    result = EmployeePage.model_validate(
        {
            "items": items,
            "total": total,
            "page": page,
            "per_page": per_page,
            # Округление вверх без вещественной арифметики: 0 страниц при пустом списке.
            "pages": -(-total // per_page),
        }
    )
    # Тело собирается здесь, как и у поверхности: иначе двадцать карточек по
    # дороге проходят через `jsonable_encoder` — ровно та работа, которую убирает
    # тикет. Схему по-прежнему проверяет модель из `response_model`, поэтому
    # договор не меняется, а `test_personnel_contract.py` держит оба маршрута.
    #
    # Дамп в режиме `python`, а не `json`: `json_response` не принимает дату,
    # `Decimal` и `NaN`, и страница ведёт себя так же, как поверхность. В режиме
    # `json` Pydantic молча превратил бы их в строки, и правило «не JSON-тип в
    # теле — ошибка данных» действовало бы только на одном маршруте из двух.
    return json_response(result.model_dump())


@router.get("/finished-shifts", response_model=TablePage[FinishedShift])
def list_finished_shifts(
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    start: Annotated[date, Query(alias="from")],
    end: Annotated[date, Query(alias="to")],
    dormitory: Annotated[int | None, Query(ge=1)] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    query: Annotated[str, Query(max_length=255)] = "",
) -> TablePage[FinishedShift]:
    period_bounds(start, end)
    ids = (
        [own_dormitory(db, dormitory, membership).id]
        if dormitory is not None
        else dormitory_scope(db, membership)
    )
    return finished_shifts(db, ids, start, end, PageRequest(page=page, q=query))


@router.post("/export")
def export_selected(
    payload: PersonnelExportInput, user: ExportUser, membership: Membership, db: DbSession
) -> Response:
    data = workspace(db, user, dormitory_scope(db, membership))
    return Response(
        export_people(data, payload),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="personnel-{today()}.xlsx"',
            "Cache-Control": "no-store",
        },
    )


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
    require_writable_table(db, payload.dormitory_id, payload.table_key, data=True)
    columns = ensure_columns(db, payload.dormitory_id, payload.table_key)
    entry_columns = (
        {str(role): column for role, column in payload.entry_columns.items()}
        if payload.entry_columns is not None
        else None
    )
    if payload.table_key == "residents":
        checked_entry_fields(db, payload.dormitory_id, payload.identity.model_dump(), entry_columns)
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
        if payload.table_key == "residents" and fields.get("gender") is not None:
            validate_resident_gender(db, payload.dormitory_id, fields["gender"])
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
    if isinstance(row, Resident):
        write_entry_identity(db, row, {"full_name", "phone"}, entry_columns)
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
    require_writable_table(db, payload.dormitory_id, payload.table_key, data=True)
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


@router.get("/employees/{employee_id}/profile")
def get_employee_profile(
    employee_id: UUID,
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    dormitories = scoped_dormitories(db, membership.organization_id)
    return load_profile(db, membership.organization_id, dormitories, employee_id=str(employee_id))


@router.post("/employee-profile/by-name")
def get_employee_profile_by_name(
    payload: EmployeeProfileLookup,
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    dormitories = scoped_dormitories(db, membership.organization_id)
    return load_profile(db, membership.organization_id, dormitories, full_name=payload.full_name)


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
    item.settings = payload.model_dump(mode="json", by_alias=True, exclude={"revision"})
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
    columns = read_columns(db, dormitory_id, table_key)
    item = db.scalar(
        select(PersonnelBinding).where(
            PersonnelBinding.dormitory_id == dormitory_id, PersonnelBinding.table_key == table_key
        )
    )
    db.commit()
    return {
        "fields": entry_fields(db, dormitory_id, columns)
        if table_key == "residents"
        else item.fields
        if item
        else {},
        "columns": [
            {
                "id": c.id,
                "name": c.name,
                "kind": c.kind,
                "builtin_key": c.builtin_key,
                "has_fill": bool(c.fill),
                "can_convert_to_text": table_key == "residents"
                and c.kind == "number"
                and column_type_change_reason(db, c) is None,
            }
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
    if table_key == "residents":
        lock_dormitory(db, dormitory_id)
        require_writable_table(db, dormitory_id, table_key)
        for resident in save_entry_fields(
            db,
            dormitory_id,
            {str(role): column for role, column in payload.fields.items()},
            payload.convert_phone_to_text,
        ):
            record_changed(
                db, resident, user.id, kind="source", title="Настроены столбцы формы добавления"
            )
        db.commit()
        return {"ok": True}
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
        if col and col.fill:
            raise HTTPException(
                409, "Связанный столбец нельзя назначить полю персонала. Выберите ручной столбец."
            )
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
