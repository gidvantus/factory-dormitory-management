"""Точка входа FastAPI кабинета оператора.

Всё API лежит под префиксом `/api` — так же, как у основного приложения, чтобы
nginx кабинета проксировал один путь `/api/` и фронтенд ходил на относительный
`/api`. Сервис самостоятельный: своей базы, миграций и обмена с основным
кабинетом у него нет.
"""

import logging

from fastapi import FastAPI

from app.api import auth, health

API_PREFIX = "/api"

# Логи приложения видны в контейнере `operator-api`. Uvicorn поднимает только
# свои логгеры, а корневой оставляет на WARNING — поэтому INFO самого проекта
# (и всё, что пишет FastAPI) в лог не попадало бы вовсе. `basicConfig` ничего не
# делает, если корневой логгер уже настроен, поэтому чужая конфигурация не
# ломается.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def create_app() -> FastAPI:
    """Собрать приложение: роуты под общим префиксом `/api`."""
    application = FastAPI(
        title="Кабинет оператора",
        version="0.1.0",
        description=(
            "Сервис входа в кабинет оператора: логин и пароль из конфига, "
            "сессия в httpOnly cookie `operator_session`."
        ),
    )
    application.include_router(auth.router, prefix=API_PREFIX)
    application.include_router(health.router, prefix=API_PREFIX)
    return application


app = create_app()
