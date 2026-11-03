"""История данных через подвкладку типа «Архив», только в своём общежитии."""

from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser
from app.db import get_db
from app.models.dormitory_history import DormitoryDataEvent
from app.table_data import get_custom_tab

router = APIRouter(tags=["dormitory-history"], responses={**SUBSCRIBED_USER_RESPONSES})
DbSession = Annotated[Session, Depends(get_db)]


class HistoryItem(BaseModel):
    id: int
    date: datetime
    action: str
    author: str


class HistoryPage(BaseModel):
    items: list[HistoryItem]
    next_cursor: str | None = None


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


@router.get("/dormitories/{dormitory_id}/tabs/{tab_id}/history", response_model=HistoryPage)
def read_history(
    dormitory_id: int,
    tab_id: int,
    _user: SubscribedUser,
    db: DbSession,
    dormitory: OwnDormitory,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
    cursor: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> HistoryPage:
    tab = get_custom_tab(db, dormitory_id, tab_id)
    if tab.kind != "archive":
        raise HTTPException(409, "Эта вкладка не является архивом действий")
    if (
        from_date > to_date
        or (to_date - from_date).days > 365
        or from_date.year < 2
        or to_date.year > 9998
    ):
        raise HTTPException(422, "Выберите период не длиннее года")
    zone = ZoneInfo("Europe/Moscow")
    start = datetime.combine(from_date, time.min, zone).astimezone(UTC)
    end = datetime.combine(to_date + timedelta(days=1), time.min, zone).astimezone(UTC)
    statement = select(DormitoryDataEvent).where(
        DormitoryDataEvent.dormitory_id == dormitory_id,
        DormitoryDataEvent.organization_id == dormitory.organization_id,
        DormitoryDataEvent.created_at >= start,
        DormitoryDataEvent.created_at < end,
    )
    if cursor:
        try:
            stamp, identifier = cursor.rsplit("|", 1)
            moment = datetime.fromisoformat(stamp)
            if (
                moment.tzinfo is None
                or not 2 <= moment.year <= 9998
                or not 0 < int(identifier) <= 2**63 - 1
            ):
                raise ValueError
        except ValueError as exc:
            raise HTTPException(422, "Некорректный курсор страницы") from exc
        statement = statement.where(
            or_(
                DormitoryDataEvent.created_at < utc(moment),
                and_(
                    DormitoryDataEvent.created_at == utc(moment),
                    DormitoryDataEvent.id < int(identifier),
                ),
            )
        )
    rows = list(
        db.scalars(
            statement.order_by(
                DormitoryDataEvent.created_at.desc(), DormitoryDataEvent.id.desc()
            ).limit(limit + 1)
        )
    )
    page = rows[:limit]
    return HistoryPage(
        items=[
            HistoryItem(
                id=row.id, date=utc(row.created_at), action=row.action, author=row.actor_name
            )
            for row in page
        ],
        next_cursor=f"{utc(page[-1].created_at).isoformat()}|{page[-1].id}"
        if len(rows) > limit
        else None,
    )
