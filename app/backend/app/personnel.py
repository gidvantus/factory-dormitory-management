"""Связывание людей с исходными строками. Совпадения никогда не объединяются автоматически."""

import hashlib
import json
import re
from collections import defaultdict
from contextlib import suppress
from datetime import date, datetime
from difflib import SequenceMatcher
from typing import Any, cast
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.arrival_plans import active_arrivals
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.personnel import (
    Employee,
    EmployeeAlias,
    EmployeeEvent,
    EmployeeMerge,
    EmployeeNote,
    EmployeePlan,
    PersonnelBinding,
    PersonnelPreferences,
)
from app.models.resident import Resident
from app.models.table_column import ArchiveEntry, TableColumn
from app.models.user import User
from app.schemas.personnel import IdentityChoice, IdentityFields

Row = Resident | PersonnelInflow | PersonnelOutflow | CustomTabEntry | ArchiveEntry
SOURCE_MODELS: tuple[type[Row], ...] = (
    Resident,
    PersonnelInflow,
    PersonnelOutflow,
    CustomTabEntry,
    ArchiveEntry,
)
IDENTITY_FIELDS = ("full_name", "personnel_number", "phone")
SOURCE_NAMES = {
    "residents": "Проживающие",
    "inflow": "Приток",
    "outflow": "Отток",
    "archive": "Архив",
}


def today() -> date:
    return datetime.now(ZoneInfo("Europe/Moscow")).date()


def identity_lock(db: Session) -> None:
    # Общий замок сериализует окончательную проверку и создание, включая разные общежития.
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(723190031)"))


def normalized(field: str, value: str | None) -> str:
    value = value or ""
    if field == "phone":
        digits = re.sub(r"\D", "", value)
        return "7" + digits[1:] if len(digits) == 11 and digits.startswith("8") else digits
    return " ".join(re.sub(r"[^\w\s]", " ", value.casefold().replace("ё", "е")).split())


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def root_map(db: Session) -> tuple[dict[str, Employee], dict[str, str]]:
    employees = {item.id: item for item in db.scalars(select(Employee))}
    roots: dict[str, str] = {}
    for employee_id in employees:
        current = employee_id
        seen: set[str] = set()
        while employees[current].merged_into_id:
            if current in seen:
                raise HTTPException(409, "Обнаружена некорректная связь карточек")
            seen.add(current)
            target = employees[current].merged_into_id
            if target not in employees:
                raise HTTPException(409, "Связанная карточка не найдена")
            current = target
        roots[employee_id] = current
    return employees, roots


def get_employee(db: Session, employee_id: str) -> Employee:
    employees, roots = root_map(db)
    if employee_id not in employees:
        raise HTTPException(404, "Карточка сотрудника не найдена")
    return employees[roots[employee_id]]


def group_ids(db: Session, employee_id: str) -> list[str]:
    employees, roots = root_map(db)
    if employee_id not in employees:
        raise HTTPException(404, "Карточка сотрудника не найдена")
    return [id for id, root in roots.items() if root == roots[employee_id]]


def group_identities(
    employees: dict[str, Employee], roots: dict[str, str]
) -> dict[str, dict[str, Any]]:
    result = {
        root: {field: getattr(employees[root], field) for field in IDENTITY_FIELDS}
        for root in set(roots.values())
    }
    for item in employees.values():
        for field in IDENTITY_FIELDS:
            if not result[roots[item.id]][field] and getattr(item, field):
                result[roots[item.id]][field] = getattr(item, field)
    return result


def source_key(row: Row) -> str:
    if isinstance(row, Resident):
        return "residents"
    if isinstance(row, PersonnelInflow):
        return "inflow"
    if isinstance(row, PersonnelOutflow):
        return "outflow"
    if isinstance(row, CustomTabEntry):
        return f"custom_{row.tab_id}"
    return "archive"


def row_values(db: Session, row: Row, lookup: dict[str, Any] | None = None) -> dict[str, Any]:
    values = {
        column.key: getattr(row, column.key)
        for column in row.__table__.columns
        if column.key != "employee_id"
    }
    values = json.loads(json.dumps(values, default=lambda value: value.isoformat()))
    dormitory = (
        lookup["dormitories"].get(row.dormitory_id)
        if lookup is not None
        else db.get(Dormitory, row.dormitory_id)
    )
    values["dormitory_name"] = dormitory.name if dormitory else "Удалённое общежитие"
    values["client_name"] = dormitory.client_name if dormitory else ""
    if isinstance(row, Resident) and row.hostel_id:
        hostel = (
            lookup["hostels"].get(row.hostel_id)
            if lookup is not None
            else db.get(Hostel, row.hostel_id)
        )
        values["hostel_name"] = hostel.name if hostel else None
    key = source_key(row)
    binding = (
        lookup["bindings"].get((row.dormitory_id, key))
        if lookup is not None
        else db.scalar(
            select(PersonnelBinding).where(
                PersonnelBinding.dormitory_id == row.dormitory_id, PersonnelBinding.table_key == key
            )
        )
    )
    if binding:
        for field, column_id in binding.fields.items():
            value = (row.custom_values or {}).get(str(column_id))
            if value is not None:
                values[field] = str(value)
    return values


def add_aliases(db: Session, employee_id: str, values: dict[str, Any]) -> None:
    existing = {
        (a.field, a.value)
        for a in db.scalars(select(EmployeeAlias).where(EmployeeAlias.employee_id == employee_id))
    }
    for field in IDENTITY_FIELDS:
        raw = str(values.get(field) or "").strip()
        if len(raw) > {"full_name": 255, "personnel_number": 40, "phone": 30}[field]:
            continue
        value = normalized(field, raw)
        if value and (field, value) not in existing:
            db.add(EmployeeAlias(employee_id=employee_id, field=field, value=value, raw_value=raw))
            existing.add((field, value))
    db.flush()


def event(
    db: Session,
    employee_id: str,
    kind: str,
    title: str,
    actor_id: int | None,
    *,
    dormitory_id: int | None = None,
    source_table: str | None = None,
    source_id: int | None = None,
    snapshot: dict[str, Any] | None = None,
    happened_on: date | None = None,
) -> None:
    db.add(
        EmployeeEvent(
            employee_id=employee_id,
            kind=kind,
            title=title,
            actor_id=actor_id,
            dormitory_id=dormitory_id,
            source_table=source_table,
            source_id=source_id,
            snapshot=snapshot or {},
            happened_on=happened_on or today(),
        )
    )


def record_changed(
    db: Session,
    row: Row,
    actor_id: int | None,
    *,
    kind: str | None = None,
    title: str | None = None,
) -> None:
    """Вызывается в той же транзакции, что исходное изменение, до удаления строки."""
    identity_lock(db)
    db.flush()
    values = row_values(db, row)
    valid_identity = {
        field: values.get(field)
        if len(str(values.get(field) or ""))
        <= {"full_name": 255, "personnel_number": 40, "phone": 30}[field]
        else None
        for field in IDENTITY_FIELDS
    }
    key = source_key(row)
    tab = db.get(CustomTab, row.tab_id) if isinstance(row, CustomTabEntry) else None
    label = tab.name if tab else SOURCE_NAMES.get(key, key)
    values["source_name"] = label
    previous = next(
        (
            entry
            for entry in db.scalars(
                select(EmployeeEvent)
                .where(EmployeeEvent.source_table == key, EmployeeEvent.source_id == row.id)
                .order_by(EmployeeEvent.id.desc())
            )
            if "custom_values" in entry.snapshot
        ),
        None,
    )
    if not row.employee_id:
        if isinstance(row, (CustomTabEntry, ArchiveEntry)) and not any(
            values.get(field) for field in IDENTITY_FIELDS
        ):
            return
        business = {
            key: value
            for key, value in values.items()
            if key
            not in (
                "id",
                "dormitory_id",
                "created_at",
                "dormitory_name",
                "client_name",
                "tab_id",
                "source_name",
            )
        }
        if not any(business.values()):
            return
        employee = Employee(**valid_identity, identity_status="pending")
        db.add(employee)
        db.flush()
        row.employee_id = employee.id
    employee = get_employee(db, row.employee_id)
    sole_source = (
        employee.id == row.employee_id
        and len(group_ids(db, employee.id)) == 1
        and sum(
            db.scalar(
                select(func.count()).select_from(model).where(model.employee_id == employee.id)
            )
            or 0
            for model in (Resident, PersonnelInflow, PersonnelOutflow, CustomTabEntry, ArchiveEntry)
        )
        == 1
    )
    for field in IDENTITY_FIELDS:
        if (
            employee.id == row.employee_id
            and not getattr(employee, field)
            and valid_identity.get(field)
        ) or (
            sole_source
            and previous
            and field in values
            and getattr(employee, field) == previous.snapshot.get(field)
        ):
            setattr(employee, field, valid_identity[field])
    add_aliases(db, row.employee_id, values)
    if not kind and previous and previous.snapshot == values:
        return
    first = previous is None
    event_kind = kind or (
        "outflow"
        if key == "outflow" and first
        else "arrival"
        if key in ("residents", "inflow") and first
        else "source"
    )
    happened = None
    if first:
        raw_date = values.get(
            "departure_date"
            if key == "outflow"
            else "settlement_date"
            if key == "inflow"
            else "shift_start"
        )
        if raw_date:
            with suppress(ValueError):
                happened = date.fromisoformat(raw_date)
    event(
        db,
        row.employee_id,
        event_kind,
        title or f"{label} · {'добавлена запись' if first else 'обновлены данные'}",
        actor_id,
        dormitory_id=row.dormitory_id,
        source_table=key,
        source_id=row.id,
        snapshot=values,
        happened_on=happened,
    )
    db.flush()


def fulfill_arrival(db: Session, resident: Resident, actor_id: int) -> None:
    if not resident.employee_id:
        return
    ids = group_ids(db, resident.employee_id)
    for plan in db.scalars(
        select(EmployeePlan).where(
            EmployeePlan.employee_id.in_(ids),
            EmployeePlan.kind == "arrival",
            EmployeePlan.dormitory_id == resident.dormitory_id,
            EmployeePlan.date <= today(),
        )
    ):
        event(
            db,
            plan.employee_id,
            "plan",
            "План заезда выполнен · оформлено проживание",
            actor_id,
            dormitory_id=resident.dormitory_id,
            snapshot={
                "date": plan.date.isoformat(),
                "end": plan.end.isoformat() if plan.end else None,
            },
        )
        db.delete(plan)


def all_sources(db: Session) -> list[tuple[Row, dict[str, Any]]]:
    lookup = {
        "dormitories": {item.id: item for item in db.scalars(select(Dormitory))},
        "hostels": {item.id: item for item in db.scalars(select(Hostel))},
        "bindings": {
            (item.dormitory_id, item.table_key): item
            for item in db.scalars(select(PersonnelBinding))
        },
    }
    return [
        (cast(Row, row), row_values(db, cast(Row, row), lookup))
        for model in SOURCE_MODELS
        for row in db.scalars(select(model).where(model.employee_id.is_not(None)))
    ]


def identity_index(
    db: Session,
) -> tuple[dict[str, Employee], dict[str, str], dict[str, dict[str, set[str]]]]:
    employees, roots = root_map(db)
    active = {roots[id] for id in db.scalars(select(EmployeeEvent.employee_id).distinct())}
    for model in SOURCE_MODELS:
        active.update(
            roots[id or ""]
            for id in db.scalars(
                select(model.employee_id).where(model.employee_id.is_not(None)).distinct()
            )
        )
    aliases: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for alias in db.scalars(select(EmployeeAlias)):
        if roots[alias.employee_id] in active:
            aliases[roots[alias.employee_id]][alias.field].add(alias.value)
    for item in employees.values():
        if roots[item.id] not in active:
            continue
        for field in IDENTITY_FIELDS:
            if value := normalized(field, getattr(item, field)):
                aliases[roots[item.id]][field].add(value)
    return employees, roots, aliases


def score_match(
    left: dict[str, set[str]], right: dict[str, set[str]]
) -> tuple[int, list[str], list[str]]:
    score = 0
    evidence: list[str] = []
    differences: list[str] = []
    labels = {"personnel_number": "Табельный номер", "phone": "Телефон", "full_name": "ФИО"}
    for field, weight in (("personnel_number", 50), ("phone", 55), ("full_name", 35)):
        a, b = left.get(field, set()), right.get(field, set())
        if a & b:
            score += weight
            evidence.append(f"Совпадает {labels[field].lower()}")
        elif a and b:
            differences.append(f"Различается {labels[field].lower()}")
    if not (left.get("full_name", set()) & right.get("full_name", set())):
        names = [
            (a, b) for a in left.get("full_name", set()) for b in right.get("full_name", set())
        ]
        if any(
            a.split()[0] == b.split()[0] or SequenceMatcher(None, a, b).ratio() >= 0.82
            for a, b in names
        ):
            score += 15
            evidence.append("Похожее ФИО или совпадает фамилия")
    return score, evidence, differences


def check_identity(db: Session, fields: IdentityFields) -> dict[str, Any]:
    employees, roots, aliases = identity_index(db)
    query = {
        field: {value} if (value := normalized(field, getattr(fields, field))) else set()
        for field in IDENTITY_FIELDS
    }
    identities = group_identities(employees, roots)
    candidates: list[dict[str, Any]] = []
    sources = all_sources(db)
    for employee_id in sorted(aliases):
        score, evidence, differences = score_match(query, aliases[employee_id])
        if score == 0:
            continue
        employee = employees[employee_id]
        locations = sorted(
            {
                values["dormitory_name"]
                for row, values in sources
                if roots.get(row.employee_id or "") == employee_id
            }
        )
        candidates.append(
            {
                "id": employee.id,
                **identities[employee_id],
                "identity_status": employee.identity_status,
                "dormitories": locations,
                "score": score,
                "evidence": evidence,
                "differences": differences,
            }
        )
    candidates.sort(key=lambda item: (-item["score"], item["full_name"] or "", item["id"]))
    token = digest(
        {
            "fields": fields.model_dump(),
            "candidates": candidates,
            "values": {
                item["id"]: {field: sorted(values) for field, values in aliases[item["id"]].items()}
                for item in candidates
            },
        }
    )
    return {"candidates": candidates, "check_token": token}


def choose_identity(db: Session, choice: IdentityChoice) -> Employee:
    identity_lock(db)
    fields = IdentityFields(**{field: getattr(choice, field) for field in IDENTITY_FIELDS})
    checked = check_identity(db, fields)
    if checked["check_token"] != choice.check_token:
        raise HTTPException(
            409, "Список совпадений изменился. Повторите проверку перед сохранением"
        )
    if choice.mode == "existing":
        return get_employee(db, str(choice.employee_id))
    employee = Employee(
        **fields.model_dump(), identity_status="confirmed" if choice.mode == "new" else "pending"
    )
    db.add(employee)
    db.flush()
    add_aliases(db, employee.id, fields.model_dump())
    return employee


def workspace(db: Session, user: User) -> dict[str, Any]:
    employees, roots = root_map(db)
    identities = group_identities(employees, roots)
    dormitories = list(db.scalars(select(Dormitory).order_by(Dormitory.name, Dormitory.id)))
    sources: dict[str, list[dict[str, Any]]] = defaultdict(list)
    tabs = {f"custom_{tab.id}": tab.name for tab in db.scalars(select(CustomTab))}
    for row, values in all_sources(db):
        key = source_key(row)
        sources[roots[row.employee_id or ""]].append(
            {
                "table_key": key,
                "row_id": row.id,
                "dormitory_id": row.dormitory_id,
                "source_name": tabs.get(key, SOURCE_NAMES.get(key, key)),
                "values": values,
            }
        )
    history_dorms: dict[str, set[int]] = defaultdict(set)
    history_ids: set[str] = set()
    for entry in db.scalars(select(EmployeeEvent).order_by(EmployeeEvent.id)):
        root = roots[entry.employee_id]
        history_ids.add(root)
        if entry.dormitory_id:
            history_dorms[root].add(entry.dormitory_id)
    variants: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for alias in db.scalars(select(EmployeeAlias)):
        variants[roots[alias.employee_id]][alias.field].add(alias.raw_value)
    result = []
    for id in sorted(set(roots.values())):
        item = employees[id]
        rows = sources[id]
        if not rows and id not in history_ids:
            continue
        current = [source for source in rows if source["table_key"] == "residents"]
        result.append(
            {
                "id": id,
                **identities[id],
                "identity_status": item.identity_status,
                "member_ids": sorted(member for member, root in roots.items() if root == id),
                "sources": rows,
                "current": current,
                "history_dormitory_ids": sorted(history_dorms[id]),
                "variants": {field: sorted(values) for field, values in variants[id].items()},
            }
        )

    def person(id: str) -> str:
        return roots[id]

    preferences = db.get(PersonnelPreferences, user.id)
    return {
        "today": today(),
        "dormitories": [
            {"id": d.id, "name": d.name, "client_name": d.client_name, "is_archived": d.is_archived}
            for d in dormitories
        ],
        "employees": result,
        "source_columns": [
            {
                "id": column.id,
                "dormitory_id": column.dormitory_id,
                "table_key": column.table_key,
                "source_name": tabs.get(column.table_key, SOURCE_NAMES.get(column.table_key)),
                "name": column.name,
                "kind": column.kind,
                "builtin_key": column.builtin_key,
                "options": column.options,
            }
            for column in db.scalars(
                select(TableColumn)
                .where(TableColumn.archived.is_(False), TableColumn.kind != "action")
                .order_by(TableColumn.dormitory_id, TableColumn.table_key, TableColumn.position)
            )
            if column.table_key in SOURCE_NAMES or column.table_key in tabs
        ],
        "arrival_plans": active_arrivals(db),
        "plans": [
            {
                "id": p.id,
                "employee_id": person(p.employee_id),
                "kind": p.kind,
                "date": p.date,
                "end": p.end,
                "dormitory_id": p.dormitory_id,
                "confirmed": p.confirmed,
                "comment": p.comment,
            }
            for p in db.scalars(select(EmployeePlan).order_by(EmployeePlan.date, EmployeePlan.id))
        ],
        "preferences": {"revision": preferences.revision, **preferences.settings}
        if preferences
        else {"revision": 0, "blocks": None, "lists": []},
    }


def employee_detail(db: Session, employee_id: str) -> dict[str, Any]:
    ids = group_ids(db, employee_id)
    names = {user.id: user.full_name for user in db.scalars(select(User))}
    events = list(
        db.scalars(
            select(EmployeeEvent)
            .where(EmployeeEvent.employee_id.in_(ids))
            .order_by(EmployeeEvent.happened_on.desc(), EmployeeEvent.id.desc())
        )
    )
    notes = list(
        db.scalars(
            select(EmployeeNote)
            .where(EmployeeNote.employee_id.in_(ids))
            .order_by(EmployeeNote.created_at.desc(), EmployeeNote.id.desc())
        )
    )
    merges = list(
        db.scalars(
            select(EmployeeMerge)
            .where((EmployeeMerge.source_id.in_(ids)) | (EmployeeMerge.target_id.in_(ids)))
            .order_by(EmployeeMerge.created_at.desc())
        )
    )
    return {
        "employee_id": get_employee(db, employee_id).id,
        "events": [
            {
                "id": e.id,
                "kind": e.kind,
                "title": e.title,
                "date": e.happened_on,
                "created_at": e.created_at,
                "actor": names.get(e.actor_id or 0, "Система"),
                "dormitory_id": e.dormitory_id,
                "source_table": e.source_table,
                "source_id": e.source_id,
                "snapshot": e.snapshot,
            }
            for e in events
        ],
        "notes": [
            {
                "id": n.id,
                "text": n.text,
                "author": names.get(n.author_id or 0, "Удалённый пользователь"),
                "created_at": n.created_at,
            }
            for n in notes
        ],
        "merges": [
            {
                "id": m.id,
                "source_id": m.source_id,
                "target_id": m.target_id,
                "reason": m.reason,
                "actor": names.get(m.actor_id or 0, "Система"),
                "created_at": m.created_at,
                "undone_at": m.undone_at,
            }
            for m in merges
        ],
    }
