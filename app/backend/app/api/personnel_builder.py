"""Конструктор подвкладок персонала организации: хранение, источники и расчёты."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser
from app.api.organization import Membership
from app.db import get_db
from app.models.organization import Organization
from app.models.personnel_builder import PersonnelBuilder
from app.personnel_builder import Engine, computed, validate_state
from app.personnel_builder_sources import Sources
from app.report_formula import FormulaError
from app.schemas.personnel_builder import BuilderState, Evaluation, SaveBuilder, dump_state

router = APIRouter(
    prefix="/personnel/builder", tags=["personnel"], responses=SUBSCRIBED_USER_RESPONSES
)
DbSession = Annotated[Session, Depends(get_db)]


def response(row: PersonnelBuilder | None) -> dict[str, Any]:
    return {
        "revision": row.revision if row else 0,
        "state": row.state if row else dump_state(BuilderState()),
    }


@router.get("")
def read(_user: SubscribedUser, membership: Membership, db: DbSession) -> dict[str, Any]:
    return response(db.get(PersonnelBuilder, membership.organization_id))


@router.put("")
def save(
    payload: SaveBuilder, user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    db.scalar(
        select(Organization).where(Organization.id == membership.organization_id).with_for_update()
    )
    row = db.scalar(
        select(PersonnelBuilder)
        .where(PersonnelBuilder.organization_id == membership.organization_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if payload.revision != (row.revision if row else 0):
        raise HTTPException(
            409,
            "Конструктор изменён другим сотрудником. "
            "Сохраните копию черновика и загрузите актуальную версию.",
        )
    previous = BuilderState.model_validate(row.state) if row else None
    if previous:
        updated = {t.id: t for t in payload.state.tabs}
        for old in previous.tabs:
            if old.id not in updated:
                raise HTTPException(
                    409, "Вкладку можно скрыть или перевести в архив с сохранением данных"
                )
            new = updated[old.id]
            columns = {c.id: c for c in new.columns}
            for column in old.columns:
                if column.id not in columns:
                    raise HTTPException(409, "Столбец можно скрыть с сохранением прежних значений")
                target = columns[column.id]
                if (
                    column.kind != target.kind
                    and not computed(column.rule)
                    and not computed(target.rule)
                    and any(r.values.get(column.id) not in (None, "") for r in old.rows)
                ):
                    raise HTTPException(409, "Тип заполненного столбца сохраняется")
    try:
        validate_state(payload.state, Sources(db, user, membership.organization_id), previous)
    except FormulaError as exc:
        raise HTTPException(422, str(exc)) from exc
    if row is None:
        row = PersonnelBuilder(organization_id=membership.organization_id, revision=0, state={})
        db.add(row)
    row.state = dump_state(payload.state)
    row.revision += 1
    db.commit()
    return response(row)


@router.get("/sources")
def sources(user: SubscribedUser, membership: Membership, db: DbSession) -> dict[str, Any]:
    env = Sources(db, user, membership.organization_id)
    return {"sources": env.catalog(), "templates": env.templates()}


@router.post("/evaluate")
def evaluate(
    payload: Evaluation, user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    env = Sources(db, user, membership.organization_id)
    row = db.get(PersonnelBuilder, membership.organization_id)
    try:
        validate_state(payload.state, env, BuilderState.model_validate(row.state) if row else None)
    except FormulaError as exc:
        raise HTTPException(422, str(exc)) from exc
    return Engine(payload.state, env, payload).evaluate()
