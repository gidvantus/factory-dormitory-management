"""Сводные показатели по всем общежитиям из формульных строк большого отчёта."""

from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.reports import read_report
from app.db import get_db
from app.models.dormitory import Dormitory
from app.report_defaults import REQUIRED_REPORT_ROW_NAMES
from app.schemas.dashboard import (
    DashboardClient,
    DashboardDay,
    DashboardDormitory,
    DashboardResponse,
    DashboardTotals,
)
from app.schemas.report import ReportRowResponse
from app.security import ACTIVE_USER_RESPONSES, ActiveUser

router = APIRouter(prefix="/dashboard", tags=["dashboard"], responses={**ACTIVE_USER_RESPONSES})
DbSession = Annotated[Session, Depends(get_db)]
ATTENDANCE, RESIDENTS, TURNOVER = REQUIRED_REPORT_ROW_NAMES


def sum_complete(values: list[Decimal | None]) -> float | None:
    """Не выдавать частичную сумму, если в одном из отчётов ошибка формулы."""
    if not values or any(value is None for value in values):
        return None
    return float(sum((value for value in values if value is not None), Decimal(0)))


def metric(rows: dict[str, ReportRowResponse], name: str, day: date) -> Decimal | None:
    row = rows.get(name)
    if row is None:
        return None
    text = row.values.get(day.isoformat())
    return Decimal(text) if text is not None and day.isoformat() not in row.errors else None


def as_float(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


@router.get("", response_model=DashboardResponse, summary="Обзор по всем общежитиям")
def read_dashboard(
    _user: ActiveUser,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
    dormitory_id: Annotated[int | None, Query(ge=1)] = None,
) -> DashboardResponse:
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Выберите период не длиннее года")

    today = datetime.now(ZoneInfo("Europe/Moscow")).date()
    snapshot_date = min(to_date, today) if from_date <= today else None
    days = (
        [
            from_date + timedelta(days=offset)
            for offset in range((min(to_date, today) - from_date).days + 1)
        ]
        if snapshot_date is not None
        else []
    )
    dormitories = list(
        db.scalars(select(Dormitory).order_by(Dormitory.created_at.desc(), Dormitory.id.desc()))
    )
    if dormitory_id is not None and not any(item.id == dormitory_id for item in dormitories):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Общежитие не найдено")
    by_day: dict[date, dict[str, list[Decimal | None]]] = {
        day: {name: [] for name in REQUIRED_REPORT_ROW_NAMES} for day in days
    }
    chart_by_day: dict[date, dict[str, list[Decimal | None]]] = {
        day: {name: [] for name in REQUIRED_REPORT_ROW_NAMES} for day in days
    }
    by_client: dict[str, list[Decimal | None]] = defaultdict(list)
    dormitory_results: list[DashboardDormitory] = []

    for dormitory in dormitories:
        report = (
            read_report(dormitory.id, _user, db, from_date, snapshot_date)
            if snapshot_date
            else None
        )
        rows = {row.name: row for row in report.rows} if report else {}

        for day in days:
            for name in REQUIRED_REPORT_ROW_NAMES:
                value = metric(rows, name, day)
                by_day[day][name].append(value)
                if dormitory_id is None or dormitory.id == dormitory_id:
                    chart_by_day[day][name].append(value)

        snapshot = {
            name: metric(rows, name, snapshot_date) if snapshot_date else None
            for name in REQUIRED_REPORT_ROW_NAMES
        }
        by_client[dormitory.client_name].append(snapshot[ATTENDANCE])
        dormitory_results.append(
            DashboardDormitory(
                id=str(dormitory.id),
                name=dormitory.name,
                is_archived=dormitory.is_archived,
                residents=as_float(snapshot[RESIDENTS]),
                attendance=as_float(snapshot[ATTENDANCE]),
                turnover=as_float(snapshot[TURNOVER]),
            )
        )

    daily = [
        DashboardDay(
            date=day,
            attendance=sum_complete(chart_by_day[day][ATTENDANCE]),
            residents=sum_complete(chart_by_day[day][RESIDENTS]),
            turnover=sum_complete(chart_by_day[day][TURNOVER]),
        )
        for day in days
    ]
    snapshot_totals = by_day[snapshot_date] if snapshot_date is not None else None
    return DashboardResponse(
        snapshot_date=snapshot_date,
        totals=DashboardTotals(
            attendance=sum_complete(snapshot_totals[ATTENDANCE]) if snapshot_totals else None,
            residents=sum_complete(snapshot_totals[RESIDENTS]) if snapshot_totals else None,
        ),
        dormitories=dormitory_results,
        clients=[
            DashboardClient(name=name, attendance=sum_complete(values))
            for name, values in by_client.items()
        ],
        daily=daily,
    )
