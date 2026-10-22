"""Ручная готовность сегодняшнего отчёта; записи предыдущих дней сохраняются."""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import report_readiness as readiness
from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser
from app.db import get_db
from app.models.dormitory import Dormitory
from app.models.report_readiness import ReportReadiness
from app.schemas.report_readiness import ReportReadinessRequest, ReportReadinessResponse

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/report-readiness",
    tags=["report-readiness"],
    responses={**SUBSCRIBED_USER_RESPONSES},
)
DbSession = Annotated[Session, Depends(get_db)]
DormitoryId = Annotated[int, Path(ge=1, le=2147483647)]


@router.get("", response_model=ReportReadinessResponse)
def read_readiness(
    dormitory_id: DormitoryId,
    _user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> ReportReadinessResponse:
    if db.get(Dormitory, dormitory_id) is None:
        raise HTTPException(404, "Общежитие не найдено")
    day = readiness.today_moscow()
    return readiness.readiness_for_day(db, day, dormitory_id).get(
        dormitory_id, ReportReadinessResponse(report_date=day, is_ready=False)
    )


@router.put("", response_model=ReportReadinessResponse)
def update_readiness(
    dormitory_id: DormitoryId,
    payload: ReportReadinessRequest,
    user: SubscribedUser,
    db: DbSession,
    _dormitory: OwnDormitory,
) -> ReportReadinessResponse:
    dormitory = db.scalar(select(Dormitory).where(Dormitory.id == dormitory_id).with_for_update())
    if dormitory is None:
        raise HTTPException(404, "Общежитие не найдено")
    day = readiness.today_moscow()
    if payload.report_date != day:
        raise HTTPException(409, "Дата изменилась. Обновите отметку отчёта за сегодня.")
    item = db.scalar(
        select(ReportReadiness).where(
            ReportReadiness.dormitory_id == dormitory_id, ReportReadiness.report_date == day
        )
    )
    if item is None:
        item = ReportReadiness(dormitory_id=dormitory_id, report_date=day, is_ready=False)
        db.add(item)
    if item.is_ready != payload.is_ready:
        item.is_ready = payload.is_ready
        item.confirmed_at = datetime.now(UTC) if payload.is_ready else None
        item.confirmed_by_id = user.id if payload.is_ready else None
    db.commit()
    return readiness.readiness_for_day(db, day, dormitory_id)[dormitory_id]
