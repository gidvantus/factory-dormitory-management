"""Показатели обзора, рассчитанные из обязательных строк отчётов."""

from datetime import date

from pydantic import BaseModel

from app.schemas.dashboard_block import LayoutResponse, WidgetResult
from app.schemas.report_readiness import ReportReadinessResponse


class DashboardTotals(BaseModel):
    attendance: float | None
    residents: float | None


class DashboardDormitory(BaseModel):
    id: str
    name: str
    is_archived: bool = False
    residents: float | None
    attendance: float | None
    turnover: float | None
    vacancies: float | None = None
    report_readiness: ReportReadinessResponse


class DashboardClient(BaseModel):
    name: str
    attendance: float | None


class DashboardDay(BaseModel):
    date: date
    attendance: float | None
    residents: float | None
    turnover: float | None


class DashboardResponse(BaseModel):
    layout: LayoutResponse
    widgets: list[WidgetResult]
    report_date: date
    snapshot_date: date | None
    totals: DashboardTotals
    dormitories: list[DashboardDormitory]
    clients: list[DashboardClient]
    daily: list[DashboardDay]
