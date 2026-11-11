"""Сводные показатели действующих общежитий организации из общего отчёта."""

from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import report_readiness as readiness
from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser, scoped_dormitories
from app.api.organization import Membership
from app.api.reports import read_report
from app.dashboard_blocks import calculate_widget, layout_response
from app.db import get_db
from app.report_defaults import REPORT_METRIC_NAMES, ReportMetric
from app.schemas.dashboard import (
    DashboardBreakdown,
    DashboardBreakdownItem,
    DashboardClient,
    DashboardDay,
    DashboardDormitory,
    DashboardResponse,
    DashboardTotals,
)
from app.schemas.report import ReportResponse, ReportRowResponse
from app.schemas.report_readiness import ReportReadinessResponse

router = APIRouter(prefix="/dashboard", tags=["dashboard"], responses={**SUBSCRIBED_USER_RESPONSES})
DbSession = Annotated[Session, Depends(get_db)]
ATTENDANCE: ReportMetric = "attendance"
RESIDENTS: ReportMetric = "residents"
TURNOVER: ReportMetric = "turnover"


def sum_complete(values: list[Decimal | None]) -> float | None:
    """Не выдавать частичную сумму, если в одном из отчётов ошибка формулы."""
    if not values or any(value is None for value in values):
        return None
    return float(sum((value for value in values if value is not None), Decimal(0)))


def metric(row: ReportRowResponse | None, day: date) -> Decimal | None:
    if row is None:
        return None
    text = row.values.get(day.isoformat())
    return Decimal(text) if text is not None and day.isoformat() not in row.errors else None


def as_float(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


@router.get("/breakdowns/{metric_key}", response_model=DashboardBreakdown)
def read_breakdown(
    metric_key: ReportMetric,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
    aggregate: Literal["last", "average", "sum"] = "last",
) -> DashboardBreakdown:
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(422, "Выберите период не длиннее года")
    end = min(to_date, readiness.today_moscow())
    if end < from_date:
        return DashboardBreakdown(to_date=None, items=[])
    start = end if aggregate == "last" else from_date
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    items = []
    clients: dict[str, list[Decimal | None]] = defaultdict(list)
    for dorm in scoped_dormitories(db, membership.organization_id):
        if dorm.is_archived:
            continue
        report = read_report(dorm.id, user, db, start, end, dorm)
        row = next((row for row in report.rows if row.metric_key == metric_key), None)
        values = [metric(row, day) for day in days]
        value = None
        if all(day_value is not None for day_value in values):
            value = sum((day_value for day_value in values if day_value is not None), Decimal(0))
            if aggregate == "average":
                value /= len(days)
        if metric_key == ATTENDANCE:
            clients[dorm.client_name].append(value)
        else:
            items.append(
                DashboardBreakdownItem(id=str(dorm.id), label=dorm.name, value=as_float(value))
            )
    items.extend(
        DashboardBreakdownItem(id=name, label=name, value=sum_complete(values))
        for name, values in clients.items()
    )
    return DashboardBreakdown(to_date=end, items=items)


@router.get("", response_model=DashboardResponse, summary="Обзор по действующим общежитиям")
def read_dashboard(
    _user: SubscribedUser,
    membership: Membership,
    db: DbSession,
    from_date: Annotated[date, Query(alias="from")],
    to_date: Annotated[date, Query(alias="to")],
    dormitory_id: Annotated[int | None, Query(ge=1)] = None,
) -> DashboardResponse:
    if from_date > to_date or (to_date - from_date).days > 365:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Выберите период не длиннее года")

    today = readiness.today_moscow()
    report_statuses = readiness.readiness_for_day(db, today)
    snapshot_date = min(to_date, today) if from_date <= today else None
    days = (
        [
            from_date + timedelta(days=offset)
            for offset in range((min(to_date, today) - from_date).days + 1)
        ]
        if snapshot_date is not None
        else []
    )
    dormitories = [
        item for item in scoped_dormitories(db, membership.organization_id) if not item.is_archived
    ]
    if dormitory_id is not None and not any(item.id == dormitory_id for item in dormitories):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Общежитие не найдено")
    by_day: dict[date, dict[ReportMetric, list[Decimal | None]]] = {
        day: {key: [] for key in REPORT_METRIC_NAMES} for day in days
    }
    chart_by_day: dict[date, dict[ReportMetric, list[Decimal | None]]] = {
        day: {key: [] for key in REPORT_METRIC_NAMES} for day in days
    }
    by_client: dict[str, list[Decimal | None]] = defaultdict(list)
    dormitory_results: list[DashboardDormitory] = []
    reports: dict[int, ReportResponse] = {}

    for dormitory in dormitories:
        report = (
            read_report(dormitory.id, _user, db, from_date, snapshot_date, dormitory)
            if snapshot_date
            else None
        )
        rows = {row.metric_key: row for row in report.rows if row.metric_key} if report else {}
        if report:
            reports[dormitory.id] = report

        for day in days:
            for name in REPORT_METRIC_NAMES:
                value = metric(rows.get(name), day)
                by_day[day][name].append(value)
                if dormitory_id is None or dormitory.id == dormitory_id:
                    chart_by_day[day][name].append(value)

        snapshot = {
            name: metric(rows.get(name), snapshot_date) if snapshot_date else None
            for name in REPORT_METRIC_NAMES
        }
        by_client[dormitory.client_name].append(snapshot[ATTENDANCE])
        dormitory_results.append(
            DashboardDormitory(
                id=str(dormitory.id),
                name=dormitory.name,
                is_archived=dormitory.is_archived,
                report_readiness=report_statuses.get(
                    dormitory.id, ReportReadinessResponse(report_date=today, is_ready=False)
                ),
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
    layout = layout_response(db, membership.organization_id)
    return DashboardResponse(
        layout=layout,
        widgets=[
            calculate_widget(
                db,
                _user,
                block,
                dormitories,
                from_date,
                to_date
                if block.config.source_kind == "arrival_plan" or block.config.display == "summary"
                else snapshot_date,
                reports,
            )
            for block in layout.blocks
            if f"custom:{block.id}" not in layout.hidden
        ],
        report_date=today,
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
