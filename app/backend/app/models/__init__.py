"""Модели таблиц."""

from app.models.activation import ActivationToken
from app.models.base import Base
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dashboard_block import DashboardBlock, DashboardLayout
from app.models.document import Document
from app.models.dormitory import Dormitory
from app.models.dormitory_template import DormitoryTemplate
from app.models.hostel import Hostel, HostelCell
from app.models.import_job import ImportJob
from app.models.inflow import PersonnelInflow
from app.models.mail_template import MailTemplate
from app.models.organization import Organization, OrganizationMember
from app.models.outflow import PersonnelOutflow
from app.models.payment import PaymentEntry
from app.models.personnel import (
    Employee,
    EmployeeAlias,
    EmployeeDecision,
    EmployeeEvent,
    EmployeeMerge,
    EmployeeNote,
    EmployeePlan,
    EmployeeSeparation,
    EmployeeTask,
    PersonnelBinding,
    PersonnelPreferences,
)
from app.models.recovery_request import RecoveryRequest
from app.models.report import ReportCell, ReportRow
from app.models.report_readiness import ReportReadiness
from app.models.report_template import ReportTemplate, ReportTemplateRow
from app.models.resident import Resident
from app.models.statistics_report import StatisticsReport
from app.models.table_column import ArchiveEntry, TableColumn
from app.models.tariff import Tariff
from app.models.telegram import NotificationDelivery, NotificationSubscription, TelegramLink
from app.models.user import User

__all__ = [
    "ActivationToken",
    "ArchiveEntry",
    "Base",
    "CustomTab",
    "CustomTabEntry",
    "DashboardBlock",
    "DashboardLayout",
    "Document",
    "Dormitory",
    "DormitoryTemplate",
    "Employee",
    "EmployeeAlias",
    "EmployeeDecision",
    "EmployeeEvent",
    "EmployeeMerge",
    "EmployeeNote",
    "EmployeePlan",
    "EmployeeSeparation",
    "EmployeeTask",
    "Hostel",
    "HostelCell",
    "ImportJob",
    "MailTemplate",
    "NotificationDelivery",
    "NotificationSubscription",
    "Organization",
    "OrganizationMember",
    "PaymentEntry",
    "PersonnelBinding",
    "PersonnelInflow",
    "PersonnelOutflow",
    "PersonnelPreferences",
    "RecoveryRequest",
    "ReportCell",
    "ReportReadiness",
    "ReportRow",
    "ReportTemplate",
    "ReportTemplateRow",
    "Resident",
    "StatisticsReport",
    "TableColumn",
    "Tariff",
    "TelegramLink",
    "User",
]
