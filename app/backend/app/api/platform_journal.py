"""Журнал действий всех организаций платформы: `GET /api/platform/journal`.

Контур сервисного токена кабинета оператора (`X-Operator-Token`), как у счетов и
организаций: cookie основного кабинета здесь не работает. Ручка читает ту же таблицу
`audit_events`, что и клиентский `GET /api/journal` (`app/api/audit.py`), через общее
правило выборки `app/journal.py`, но без условия по организации.

Правила периода, курсора и `total` совпадают с клиентской лентой: отличается только
область выборки и то, что к каждой строке добавляется название организации.
"""

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.journal import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    RANGE_OUT_OF_CALENDAR_DETAIL,
    audit_conditions,
    day_bounds,
    entry,
    journal_page,
    period_range,
)
from app.models.audit import AuditEvent
from app.models.organization import Organization
from app.schemas.audit import JournalKind
from app.schemas.platform_journal import PlatformJournalEntry, PlatformJournalPage
from app.schemas.user import ErrorResponse
from app.security import INVALID_OPERATOR_TOKEN_DETAIL, require_operator_service

router = APIRouter(
    prefix="/platform/journal",
    tags=["platform"],
    dependencies=[Depends(require_operator_service)],
    responses={
        status.HTTP_401_UNAUTHORIZED: {
            "model": ErrorResponse,
            "description": INVALID_OPERATOR_TOKEN_DETAIL,
        },
    },
)

DbSession = Annotated[Session, Depends(get_db)]

PLATFORM_JOURNAL_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Период длиннее 90 дней, дата начала позже даты окончания, период в "
        "будущем, дата вне календаря, некорректный курсор, limit вне 1..200 или вид "
        "не из security/data/noise",
    },
}


def _organization_names(db: Session, rows: list[AuditEvent]) -> dict[int, str | None]:
    """Названия организаций строк страницы одним запросом по `id`, без N+1.

    Удалённая или неизвестная организация в словаре не попадает: её имя - `None`.
    """
    ids = {row.organization_id for row in rows if row.organization_id is not None}
    if not ids:
        return {}
    pairs = db.execute(
        select(Organization.id, Organization.name).where(Organization.id.in_(ids))
    ).all()
    return dict(pairs)


@router.get(
    "",
    response_model=PlatformJournalPage,
    summary="Журнал действий всех организаций",
    responses=PLATFORM_JOURNAL_RESPONSES,
)
def read_platform_journal(
    db: DbSession,
    kind: Annotated[JournalKind | None, Query()] = None,
    date_from: Annotated[date | None, Query()] = None,
    date_to: Annotated[date | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    cursor: Annotated[str | None, Query()] = None,
) -> PlatformJournalPage:
    """Лента действий по всем организациям за период, свежие сверху.

    Условия по организации нет: строки платформенного контура (`organization_id` IS
    NULL) входят в ленту и отдаются с `organization_name = null`. Период по умолчанию -
    последние 7 дней по московскому календарю; правила отказов - как у клиентского журнала.
    """
    start, end = period_range(date_from, date_to)
    try:
        lower, upper = day_bounds(start, end)
    except OverflowError:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, RANGE_OUT_OF_CALENDAR_DETAIL
        ) from None

    conditions = audit_conditions(organization_id=None, kind=kind, lower=lower, upper=upper)
    rows, next_cursor, total = journal_page(db, conditions=conditions, limit=limit, cursor=cursor)
    names = _organization_names(db, rows)
    items = [
        PlatformJournalEntry(
            **entry(row).model_dump(),
            organization_id=row.organization_id,
            organization_name=None
            if row.organization_id is None
            else names.get(row.organization_id),
        )
        for row in rows
    ]
    return PlatformJournalPage(items=items, next_cursor=next_cursor, total=total)
