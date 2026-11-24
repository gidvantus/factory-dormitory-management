"""Адресная загрузка карточки и точный поиск по ФИО в организации."""

from collections import defaultdict
from collections.abc import Iterable
from typing import Any, cast

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.arrival_settings import defaults
from app.models.arrival_plan import ArrivalSettings
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.personnel import Employee, EmployeeAlias
from app.personnel import (
    all_sources,
    employee_group_in_scope,
    employee_history,
    group_identities,
    normalized,
    source_summary,
)


def comparable_name(value: str | None) -> str:
    return " ".join((value or "").lower().replace("ё", "е").split())


def matching_ids(db: Session, full_name: str) -> set[str]:
    name = comparable_name(full_name)
    if not name:
        return set()
    matching = {
        employee_id
        for employee_id, raw in db.execute(
            select(EmployeeAlias.employee_id, EmployeeAlias.raw_value).where(
                EmployeeAlias.field == "full_name",
                EmployeeAlias.value == normalized("full_name", full_name),
            )
        )
        if comparable_name(raw) == name
    }
    # У старых карточек текущее ФИО может отсутствовать среди вариантов имени.
    matching.update(
        id
        for id, raw in db.execute(
            select(Employee.id, Employee.full_name).where(Employee.full_name.is_not(None))
        )
        if comparable_name(raw) == name
    )
    return matching


def employee_groups(db: Session, ids: set[str]) -> dict[str, dict[str, Employee]]:
    if not ids:
        return {}
    parents = (
        select(Employee.id, Employee.merged_into_id)
        .where(Employee.id.in_(ids))
        .cte("profile_parents", recursive=True)
    )
    parents = parents.union(
        select(Employee.id, Employee.merged_into_id).join(
            parents, Employee.id == parents.c.merged_into_id
        )
    )
    members = (
        select(Employee.id, Employee.id.label("root_id"))
        .where(Employee.id.in_(select(parents.c.id).where(parents.c.merged_into_id.is_(None))))
        .cte("profile_members", recursive=True)
    )
    members = members.union(
        select(Employee.id, members.c.root_id).join(
            members, Employee.merged_into_id == members.c.id
        )
    )
    statement = (
        select(members.c.root_id, Employee)
        .join(Employee, Employee.id == members.c.id)
        .order_by(Employee.id)
    )
    groups: dict[str, dict[str, Employee]] = defaultdict(dict)
    for root, employee in cast(Iterable[tuple[str, Employee]], db.execute(statement).tuples()):
        groups[root][employee.id] = employee
    return groups


def load_profile(
    db: Session,
    organization_id: int,
    dormitories: list[Dormitory],
    *,
    employee_id: str | None = None,
    full_name: str | None = None,
) -> dict[str, Any]:
    dormitory_ids = [dorm.id for dorm in dormitories]
    candidates = {employee_id} if employee_id else matching_ids(db, full_name or "")
    groups = [
        (root, members)
        for root, members in employee_groups(db, candidates).items()
        if employee_group_in_scope(db, list(members), dormitory_ids)
    ]
    if not groups:
        raise HTTPException(404, "Карточка сотрудника не найдена.")
    if len(groups) > 1:
        raise HTTPException(409, "Найдено несколько карточек с таким ФИО.")

    root, members = groups[0]
    ids = list(members)
    identities = group_identities(members, dict.fromkeys(ids, root))
    aliases: dict[str, set[str]] = defaultdict(set)
    for field, raw in db.execute(
        select(EmployeeAlias.field, EmployeeAlias.raw_value).where(
            EmployeeAlias.employee_id.in_(ids)
        )
    ):
        aliases[field].add(raw)
    rows = all_sources(db, dormitory_ids, ids)
    tab_ids = {row.tab_id for row, _ in rows if isinstance(row, CustomTabEntry)}
    tab_names = select(CustomTab.id, CustomTab.name).where(CustomTab.id.in_(tab_ids))
    tabs = {f"custom_{id}": name for id, name in db.execute(tab_names)} if tab_ids else {}
    sources = [source_summary(row, values, tabs) for row, values in rows]
    history = employee_history(db, root, ids)
    scope = set(dormitory_ids)
    settings = db.get(ArrivalSettings, organization_id)
    return {
        "employee": {
            "id": root,
            **identities[root],
            "identity_status": members[root].identity_status,
            "member_ids": ids,
            "sources": sources,
            "current": [source for source in sources if source["table_key"] == "residents"],
            "history_dormitory_ids": sorted(
                {
                    item["dormitory_id"]
                    for item in history["events"]
                    if item["dormitory_id"] in scope
                }
            ),
            "variants": {field: sorted(values) for field, values in aliases.items()},
        },
        "detail": history,
        "dormitories": [
            {"id": d.id, "name": d.name, "client_name": d.client_name, "is_archived": d.is_archived}
            for d in sorted(dormitories, key=lambda item: (item.name, item.id))
        ],
        "arrival_settings": {"fields": (settings.settings if settings else defaults())["fields"]},
    }
