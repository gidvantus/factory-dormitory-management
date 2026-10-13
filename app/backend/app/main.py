"""Точка входа FastAPI."""

from fastapi import FastAPI

from app.api import (
    activation,
    auth,
    billing,
    custom_tabs,
    dashboard,
    dashboard_blocks,
    documents,
    dormitories,
    dormitory_settings,
    dormitory_templates,
    health,
    hostels,
    inflow,
    organization,
    outflow,
    payments,
    personnel,
    recovery,
    report_readiness,
    report_templates,
    reports,
    residents,
    sections,
    statistics_reports,
    tab_catalog,
    table_columns,
    tariffs,
    telegram,
    trial,
    users,
)

API_PREFIX = "/api"


def create_app() -> FastAPI:
    """Приложение без CORS: фронт ходит на свой же origin, `/api` проксирует nginx."""
    application = FastAPI(
        title="CRM Dormitory API",
        version="0.1.0",
        description="Регистрация, вход и личный кабинет.",
    )
    application.include_router(health.router, prefix=API_PREFIX)
    application.include_router(auth.router, prefix=API_PREFIX)
    application.include_router(activation.router, prefix=API_PREFIX)
    application.include_router(recovery.router, prefix=API_PREFIX)
    application.include_router(users.router, prefix=API_PREFIX)
    application.include_router(organization.router, prefix=API_PREFIX)
    application.include_router(dashboard.router, prefix=API_PREFIX)
    application.include_router(dashboard_blocks.router, prefix=API_PREFIX)
    application.include_router(report_readiness.router, prefix=API_PREFIX)
    application.include_router(hostels.router, prefix=API_PREFIX)
    application.include_router(inflow.router, prefix=API_PREFIX)
    application.include_router(outflow.router, prefix=API_PREFIX)
    application.include_router(payments.router, prefix=API_PREFIX)
    application.include_router(personnel.router, prefix=API_PREFIX)
    application.include_router(residents.router, prefix=API_PREFIX)
    application.include_router(dormitories.router, prefix=API_PREFIX)
    application.include_router(reports.router, prefix=API_PREFIX)
    application.include_router(report_templates.router, prefix=API_PREFIX)
    application.include_router(table_columns.router, prefix=API_PREFIX)
    application.include_router(custom_tabs.router, prefix=API_PREFIX)
    application.include_router(sections.router, prefix=API_PREFIX)
    application.include_router(statistics_reports.router, prefix=API_PREFIX)
    application.include_router(tab_catalog.router, prefix=API_PREFIX)
    application.include_router(dormitory_settings.router, prefix=API_PREFIX)
    application.include_router(dormitory_templates.router, prefix=API_PREFIX)
    application.include_router(tariffs.router, prefix=API_PREFIX)
    application.include_router(billing.router, prefix=API_PREFIX)
    application.include_router(trial.router, prefix=API_PREFIX)
    application.include_router(documents.router, prefix=API_PREFIX)
    application.include_router(telegram.router, prefix=API_PREFIX)
    return application


app = create_app()
