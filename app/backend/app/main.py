"""Точка входа FastAPI."""

from fastapi import FastAPI

from app.api import auth, health, users

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
    application.include_router(users.router, prefix=API_PREFIX)
    return application


app = create_app()
