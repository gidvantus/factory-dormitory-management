"""Точка входа FastAPI кабинета оператора.

Всё API лежит под префиксом `/api` — так же, как у основного приложения, чтобы
nginx кабинета проксировал один путь `/api/` и фронтенд ходил на относительный
`/api`. Сервис самостоятельный: своей базы, миграций и обмена с основным
кабинетом у него нет.
"""

from fastapi import FastAPI

from app.api import auth, health, invoices, organizations, tariffs, users
from app.config import get_settings

API_PREFIX = "/api"


def create_app() -> FastAPI:
    """Собрать приложение: роуты под общим префиксом `/api`."""
    # Настройки проверяются здесь, а не при первом запросе: незаполненный
    # `OPERATOR_PASSWORD` или короткий `OPERATOR_TOKEN_SECRET` должны ронять старт
    # сервиса с внятным отказом, а не отдавать `500` на первом входе. Поэтому
    # `get_settings()` вызывается на сборке приложения, а не откладывается.
    get_settings()
    application = FastAPI(
        title="Кабинет оператора",
        version="0.1.0",
        description=(
            "Сервис входа в кабинет оператора: логин и пароль из конфига, "
            "сессия в httpOnly cookie `operator_session`."
        ),
    )
    application.include_router(auth.router, prefix=API_PREFIX)
    # Организации платформы: кабинет только проксирует их в основной API по
    # сервисному токену — своих данных и своей базы у него по-прежнему нет.
    application.include_router(organizations.router, prefix=API_PREFIX)
    # Пользователи платформы — второй раздел того же контура: кабинет только
    # проксирует их в основной API по сервисному токену.
    application.include_router(users.router, prefix=API_PREFIX)
    # Счета платформы — третий раздел того же контура: список всех организаций,
    # оплата, отмена и печатные формы. Кабинет только проксирует их в основной
    # API — правил статусов и своей базы у него нет.
    application.include_router(invoices.router, prefix=API_PREFIX)
    # Тарифы платформы — четвёртый раздел того же контура: весь прайс, правка
    # полей и снятие с продажи. Кабинет только проксирует их в основной API —
    # правил правки и своей базы у него нет.
    application.include_router(tariffs.router, prefix=API_PREFIX)
    application.include_router(health.router, prefix=API_PREFIX)
    return application


app = create_app()
