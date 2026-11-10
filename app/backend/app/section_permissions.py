"""Проверка прав раздела на сервере, включая прямые запросы к API."""

from fastapi import HTTPException, Request

from app.access import DbSession
from app.api.organization import membership_role
from app.role_permissions import permissions_for
from app.security import CurrentUser

SECTION_LABELS = {
    "overview": "Обзор",
    "dormitories": "Общежития",
    "personnel": "Персонал",
    "statistics": "Статистика",
    "documents": "Документы",
    "shop": "Магазин улучшений",
    "organization": "Организация",
    "members": "Сотрудники",
    "profile": "Личные данные",
}


def request_sections(path: str, method: str) -> tuple[str, ...]:
    if path == "/api/solutions/entitlements":
        return ()
    if path.startswith("/api/personnel/bindings/"):
        return ("dormitories", "personnel")
    if path in ("/api/personnel/check", "/api/personnel/records", "/api/personnel/link"):
        # Проверка ФИО, добавление и привязка строки нужны рабочим таблицам общежития.
        return ("dormitories", "personnel")
    if path.startswith("/api/personnel"):
        return ("personnel",)
    if path.startswith("/api/dashboard"):
        return ("overview",)
    if path.startswith("/api/statistics"):
        return ("statistics",)
    if path.startswith(("/api/organization/members", "/api/organization/invitations")):
        return ("members",)
    if path.startswith("/api/organization"):
        return ("organization",)
    if path.startswith("/api/billing/invoices"):
        return ("shop",) if method == "POST" else ("documents",)
    if path.startswith("/api/solutions"):
        return ("shop",)
    if path == "/api/dormitories/lookup":
        # Только названия для селекторов, в том числе правил уведомлений.
        return ()
    if path == "/api/dormitory-tab-catalog":
        return ("dormitories", "personnel", "statistics", "overview")
    if path.startswith(
        (
            "/api/dormitories",
            "/api/report-templates",
            "/api/dormitory-templates",
            "/api/custom-tab-templates",
        )
    ):
        return ("dormitories",)
    return ()


def require_section_access(request: Request, user: CurrentUser, db: DbSession) -> None:
    sections = request_sections(request.url.path, request.method)
    if not sections:
        return
    role = membership_role(user, db)
    if role is None:
        # Сохраняем штатный отказ членства/активации нижележащей ручки.
        return
    permissions = permissions_for(db, role)
    if not any(getattr(permissions, section + "_enabled") for section in sections):
        labels = ", ".join(SECTION_LABELS[section] for section in sections)
        raise HTTPException(403, f"Доступ к разделу «{labels}» отключён для вашей должности")
