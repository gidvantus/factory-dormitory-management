"""Подтверждение отчёта за конкретный день без проверки структуры таблиц."""

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, StrictBool


class ReportReadinessRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    report_date: date
    is_ready: StrictBool


class ReportReadinessResponse(BaseModel):
    report_date: date
    is_ready: bool
    confirmed_at: datetime | None = None
    confirmed_by: str | None = None
