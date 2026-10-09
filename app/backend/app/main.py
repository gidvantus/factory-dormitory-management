"""Точка входа FastAPI."""

from fastapi import FastAPI

from app.api import (
    activation,
    auth,
    dashboard,
    dormitories,
    health,
    hostels,
    inflow,
    outflow,
    payments,
    recovery,
    report_templates,
    reports,
    residents,
    table_columns,
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
    application.include_router(dashboard.router, prefix=API_PREFIX)
    application.include_router(hostels.router, prefix=API_PREFIX)
    application.include_router(inflow.router, prefix=API_PREFIX)
    application.include_router(outflow.router, prefix=API_PREFIX)
    application.include_router(payments.router, prefix=API_PREFIX)
    application.include_router(residents.router, prefix=API_PREFIX)
    application.include_router(dormitories.router, prefix=API_PREFIX)
    application.include_router(reports.router, prefix=API_PREFIX)
    application.include_router(report_templates.router, prefix=API_PREFIX)
    application.include_router(table_columns.router, prefix=API_PREFIX)
    return application


app = create_app()
