"""Модели таблиц."""

from app.models.activation import ActivationToken
from app.models.base import Base
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel, HostelCell
from app.models.inflow import PersonnelInflow
from app.models.mail_template import MailTemplate
from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.recovery_request import RecoveryRequest
from app.models.report import ReportCell, ReportRow
from app.models.report_template import ReportTemplate, ReportTemplateRow
from app.models.resident import Resident
from app.models.table_column import ArchiveEntry, TableColumn
from app.models.user import User

__all__ = [
    "ActivationToken",
    "ArchiveEntry",
    "Base",
    "Dormitory",
    "Hostel",
    "HostelCell",
    "MailTemplate",
    "PaymentEntry",
    "PersonnelInflow",
    "PersonnelOutflow",
    "RecoveryRequest",
    "ReportCell",
    "ReportRow",
    "ReportTemplate",
    "ReportTemplateRow",
    "Resident",
    "TableColumn",
    "User",
]
