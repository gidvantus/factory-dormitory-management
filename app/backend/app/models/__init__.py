"""Модели таблиц."""

from app.models.base import Base
from app.models.dormitory import Dormitory
from app.models.report import ReportCell, ReportRow
from app.models.report_template import ReportTemplate, ReportTemplateRow
from app.models.user import User

__all__ = [
    "Base",
    "Dormitory",
    "ReportCell",
    "ReportRow",
    "ReportTemplate",
    "ReportTemplateRow",
    "User",
]
