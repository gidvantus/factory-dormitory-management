"""Управление стандартными вкладками и отдельными подвкладками."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser
from app.db import get_db
from app.models.custom_tab import CustomTabEntry
from app.models.hostel import Hostel
from app.models.inflow import PersonnelInflow
from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.report import ReportCell, ReportRow
from app.models.resident import Resident
from app.models.table_column import ArchiveEntry, TableColumn
from app.report_defaults import DEFAULT_REPORT_FORMULA, required_row_name
from app.section_state import SECTIONS, locked_dormitory, section_parents, section_status
from app.tab_catalog import normalized_name
from app.tab_tree import all_tabs, delete_tabs, descendants

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/sections",
    tags=["sections"],
    responses={**SUBSCRIBED_USER_RESPONSES},
)
DbSession = Annotated[Session, Depends(get_db)]
EntityId = Annotated[int, Path(ge=1, le=2147483647)]


class SectionResponse(BaseModel):
    key: str
    name: str
    parent_key: str | None
    status: str
    has_data: bool
    delete_block_reason: str | None


class SectionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["active", "hidden"]


def section_keys(key: str, parents: dict[str, str | None]) -> list[str]:
    result = [key]
    while new := [
        child for child, parent in parents.items() if parent in result and child not in result
    ]:
        result.extend(new)
    return result


def metadata(db: Session, dormitory_id: int) -> list[SectionResponse]:
    dormitory = locked_dormitory(db, dormitory_id)
    parents = section_parents(dormitory)
    tree = all_tabs(db, dormitory_id)
    populated_custom = set(
        db.scalars(
            select(CustomTabEntry.tab_id)
            .where(CustomTabEntry.dormitory_id == dormitory_id)
            .distinct()
        )
    )
    rows = list(db.scalars(select(ReportRow).where(ReportRow.dormitory_id == dormitory_id)))
    populated: set[str] = set()
    for key, model in (
        ("residents", Resident),
        ("inflow", PersonnelInflow),
        ("outflow", PersonnelOutflow),
        ("archive", ArchiveEntry),
        ("places", Hostel),
    ):
        if (
            db.scalar(select(model.id).where(model.dormitory_id == dormitory_id).limit(1))
            is not None
        ):
            populated.add(key)
    populated.update(
        db.scalars(
            select(PaymentEntry.kind).where(PaymentEntry.dormitory_id == dormitory_id).distinct()
        )
    )
    if any(
        not required_row_name(row.name) or row.formula != DEFAULT_REPORT_FORMULA or row.link
        for row in rows
    ) or (
        rows
        and db.scalar(
            select(ReportCell.id).where(ReportCell.row_id.in_([row.id for row in rows])).limit(1)
        )
        is not None
    ):
        populated.add("report")
    result = []
    for key, name in SECTIONS.items():
        keys = section_keys(key, parents)
        custom = descendants(tree, {tab.id for tab in tree if tab.parent_section in keys})
        has_data = bool(
            populated.intersection(keys) or populated_custom.intersection(tab.id for tab in custom)
        )
        keys += [tab.table_key for tab in custom]
        dependencies = [row.name for row in rows if row.link and row.link.get("table_key") in keys]
        reason = None
        if has_data:
            reason = "Есть записи за всё время, в том числе в подвкладках. Можно только скрыть."
        elif dependencies:
            reason = (
                "Используется в строках отчёта: "
                + ", ".join(dependencies)
                + ". Измените связь или скройте вкладку."
            )
        result.append(
            SectionResponse(
                key=key,
                name=name,
                parent_key=parents.get(key),
                status=section_status(dormitory, key),
                has_data=has_data,
                delete_block_reason=reason,
            )
        )
    return result


@router.get("", response_model=list[SectionResponse])
def list_sections(
    dormitory_id: EntityId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> list[SectionResponse]:
    return metadata(db, dormitory_id)


@router.patch("/{key}", response_model=list[SectionResponse])
def update_section(
    dormitory_id: EntityId,
    key: str,
    payload: SectionUpdate,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> list[SectionResponse]:
    if key not in SECTIONS:
        raise HTTPException(404, "Вкладка не найдена")
    dormitory = locked_dormitory(db, dormitory_id)
    states = dict(dormitory.section_states)
    parents = section_parents(dormitory)
    if (
        payload.status == "active"
        and section_status(dormitory, key) == "deleted"
        and any(
            normalized_name(tab.name) == normalized_name(SECTIONS[key])
            and not tab.parent_id
            and tab.parent_section == parents.get(key)
            for tab in all_tabs(db, dormitory_id)
        )
    ):
        raise HTTPException(
            409, "Вкладка с таким названием уже есть. Сначала удалите одноимённую вкладку."
        )
    if section_status(dormitory, key) == "deleted" and payload.status != "active":
        raise HTTPException(409, "Сначала добавьте вкладку обратно")
    if (
        payload.status == "active"
        and (parent := parents.get(key))
        and section_status(dormitory, parent) != "active"
    ):
        raise HTTPException(409, "Сначала восстановите родительский раздел")
    # Re-adding a deleted group creates its usual subtab structure. Hiding a group
    # does not overwrite independent child states.
    if section_status(dormitory, key) == "deleted" and key in ("movement", "payments"):
        for child in section_keys(key, parents)[1:]:
            states.pop(child, None)
    states[key] = payload.status
    dormitory.section_states = states
    db.commit()
    return metadata(db, dormitory_id)


@router.delete("/{key}", response_model=list[SectionResponse])
def delete_section(
    dormitory_id: EntityId,
    key: str,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> list[SectionResponse]:
    if key not in SECTIONS:
        raise HTTPException(404, "Вкладка не найдена")
    dormitory = locked_dormitory(db, dormitory_id)
    item = next(item for item in metadata(db, dormitory_id) if item.key == key)
    if item.delete_block_reason:
        raise HTTPException(409, item.delete_block_reason)
    keys = section_keys(key, section_parents(dormitory))
    tree = all_tabs(db, dormitory_id)
    delete_tabs(db, descendants(tree, {tab.id for tab in tree if tab.parent_section in keys}))
    db.execute(
        delete(TableColumn).where(
            TableColumn.dormitory_id == dormitory_id, TableColumn.table_key.in_(keys)
        )
    )
    dormitory.section_states = {**dormitory.section_states, **dict.fromkeys(keys, "deleted")}
    # Required zero formulas remain as dashboard metrics, without user data.
    db.commit()
    return metadata(db, dormitory_id)
