"""Показатели обзора, рассчитанные из обязательных строк отчётов."""

from datetime import date

from pydantic import BaseModel


class DashboardTotals(BaseModel):
    attendance: float | None
    residents: float | None


class DashboardDormitory(BaseModel):
    id: str
    name: str
    residents: float | None
    attendance: float | None
    turnover: float | None
    vacancies: float | None = None


class DashboardClient(BaseModel):
    name: str
    attendance: float | None


class DashboardDay(BaseModel):
    date: date
    attendance: float | None
    residents: float | None
    turnover: float | None


class DashboardResponse(BaseModel):
    snapshot_date: date | None
    totals: DashboardTotals
    dormitories: list[DashboardDormitory]
    clients: list[DashboardClient]
    daily: list[DashboardDay]
