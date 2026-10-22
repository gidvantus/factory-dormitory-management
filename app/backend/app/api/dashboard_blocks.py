"""Общий конструктор и порядок блоков для всех активных пользователей."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser, scoped_dormitories
from app.api.organization import Membership
from app.dashboard_blocks import (
    calculate_widget,
    check_revision,
    layout_response,
    layout_row,
    source_catalog,
    validate_config,
)
from app.db import get_db
from app.models.dashboard_block import DashboardBlock
from app.report_readiness import today_moscow
from app.schemas.dashboard_block import (
    CatalogDormitory,
    LayoutMutation,
    LayoutResponse,
    WidgetConfig,
    WidgetDefinition,
    WidgetMutation,
    WidgetResult,
)

router = APIRouter(
    prefix="/dashboard", tags=["dashboard-blocks"], responses={**SUBSCRIBED_USER_RESPONSES}
)
DbSession = Annotated[Session, Depends(get_db)]
BlockId = Annotated[int, Path(ge=1)]


@router.post("/preview", response_model=WidgetResult)
def preview_block(
    payload: WidgetConfig,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
) -> WidgetResult:
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(422, "Выберите период не длиннее года")
    validate_config(db, payload, membership.organization_id)
    end = min(to_date, today_moscow()) if from_date <= today_moscow() else None
    if payload.source_kind == "arrival_plan":
        end = to_date
    dormitories = scoped_dormitories(db, membership.organization_id)
    return calculate_widget(
        db, user, WidgetDefinition(id=0, config=payload), dormitories, from_date, end, {}
    )


@router.get("/sources", response_model=list[CatalogDormitory])
def read_sources(
    _user: SubscribedUser, membership: Membership, db: DbSession
) -> list[CatalogDormitory]:
    result = source_catalog(db, membership.organization_id)
    db.commit()
    return result


@router.get("/layout", response_model=LayoutResponse)
def read_layout(_user: SubscribedUser, db: DbSession) -> LayoutResponse:
    return layout_response(db)


@router.put("/layout", response_model=LayoutResponse)
def update_layout(payload: LayoutMutation, _user: SubscribedUser, db: DbSession) -> LayoutResponse:
    layout = layout_row(db, lock=True)
    check_revision(layout, payload.revision)
    keys = set(layout_response(db, layout).order)
    if (
        len(payload.order) != len(keys)
        or set(payload.order) != keys
        or len(set(payload.hidden)) != len(payload.hidden)
        or not set(payload.hidden) <= keys
    ):
        raise HTTPException(422, "Укажите каждый существующий блок ровно один раз")
    layout.order, layout.hidden = payload.order, payload.hidden
    layout.revision += 1
    db.commit()
    return layout_response(db, layout)


@router.post("/blocks", response_model=LayoutResponse, status_code=201)
def create_block(
    payload: WidgetMutation, user: SubscribedUser, membership: Membership, db: DbSession
) -> LayoutResponse:
    layout = layout_row(db, lock=True)
    check_revision(layout, payload.revision)
    if (db.scalar(select(func.count()).select_from(DashboardBlock)) or 0) >= 100:
        raise HTTPException(422, "На дашборде можно создать до 100 пользовательских блоков")
    config = validate_config(db, payload.config, membership.organization_id)
    block = DashboardBlock(config=config.model_dump(mode="json"), created_by_id=user.id)
    db.add(block)
    db.flush()
    layout.order = [*layout.order, f"custom:{block.id}"]
    layout.revision += 1
    db.commit()
    return layout_response(db, layout)


@router.put("/blocks/{block_id}", response_model=LayoutResponse)
def update_block(
    block_id: BlockId,
    payload: WidgetMutation,
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> LayoutResponse:
    layout = layout_row(db, lock=True)
    check_revision(layout, payload.revision)
    block = db.get(DashboardBlock, block_id)
    if block is None:
        raise HTTPException(404, "Блок не найден")
    payload_config = validate_config(db, payload.config, membership.organization_id)
    block.config = payload_config.model_dump(mode="json")
    layout.revision += 1
    db.commit()
    return layout_response(db, layout)


@router.delete("/blocks/{block_id}", response_model=LayoutResponse)
def delete_block(
    block_id: BlockId, revision: Annotated[int, Query(ge=0)], _user: SubscribedUser, db: DbSession
) -> LayoutResponse:
    layout = layout_row(db, lock=True)
    check_revision(layout, revision)
    block = db.get(DashboardBlock, block_id)
    if block is None:
        raise HTTPException(404, "Блок не найден")
    db.delete(block)
    key = f"custom:{block_id}"
    layout.order = [item for item in layout.order if item != key]
    layout.hidden = [item for item in layout.hidden if item != key]
    layout.revision += 1
    db.commit()
    return layout_response(db, layout)
