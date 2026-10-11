"""Общий календарь и чтение ежедневных подтверждений для общежития и дашборда."""

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.report_readiness import ReportReadiness
from app.models.user import User
from app.schemas.report_readiness import ReportReadinessResponse


def today_moscow() -> date:
    return datetime.now(ZoneInfo("Europe/Moscow")).date()


def readiness_for_day(
    db: Session, day: date, dormitory_id: int | None = None
) -> dict[int, ReportReadinessResponse]:
    query = (
        select(ReportReadiness, User.full_name)
        .outerjoin(User, User.id == ReportReadiness.confirmed_by_id)
        .where(ReportReadiness.report_date == day)
    )
    if dormitory_id is not None:
        query = query.where(ReportReadiness.dormitory_id == dormitory_id)
    rows = db.execute(query)
    return {
        item.dormitory_id: ReportReadinessResponse(
            report_date=day,
            is_ready=item.is_ready,
            confirmed_at=(
                item.confirmed_at.replace(tzinfo=UTC)
                if item.confirmed_at is not None and item.confirmed_at.tzinfo is None
                else item.confirmed_at
            ),
            confirmed_by=name,
        )
        for item, name in rows
    }
