"""Точка входа FastAPI."""

import json
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request, Response, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import RequestResponseEndpoint

from app import audit
from app.api import (
    activation,
    arrival_plans,
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
    solutions,
    statistics_reports,
    tab_catalog,
    table_columns,
    tariffs,
    telegram,
    trial,
    users,
)

# Роутер журнала импортируется отдельной строкой: имя `audit` в этом файле уже
# занято модулем записи журнала (`app.audit`), и плоский импорт из `app.api`
# подменил бы его.
from app.api.audit import router as journal_router
from app.config import get_settings

API_PREFIX = "/api"

# Методы, у которых бывает тело. `DELETE` в этом списке нет: тела у удалений
# в этом API не бывает, а лишнее чтение потока запроса ни к чему.
BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})
# Тело сохраняется только у JSON. У `multipart/form-data` (импорт «Мест» до
# 20 МБ) тело не читается вовсе: иначе файл материализуется в памяти целиком
# ради одной строки журнала.
JSON_CONTENT_TYPE = "application/json"

# Длина колонки `ip`: больше не бывает ни у IPv4, ни у IPv6.
IP_LIMIT = 45

# Падение ручки клиент видит как 500 от сервера: этот код и попадает в журнал.
UNHANDLED_ERROR_STATUS = 500


async def read_request_body(request: Request) -> Any | None:
    """Тело запроса для журнала: только JSON и только в пределах лимита чтения.

    Тело читается до вызова ручки: поток запроса одноразовый. Middleware
    кэширует прочитанное, поэтому ручка получает своё тело как обычно.

    Запрос без `content-length` не читается вовсе: длину тела знает только
    клиент, а читать вслепую — это тот же импорт на 20 МБ в памяти.
    """
    if request.method not in BODY_METHODS:
        return None
    if not request.headers.get("content-type", "").startswith(JSON_CONTENT_TYPE):
        return None
    declared = request.headers.get("content-length")
    if declared is None or not declared.isdigit():
        return None
    if int(declared) > get_settings().audit_body_read_limit_bytes:
        return None
    body = await request.body()
    if not body:
        return None
    try:
        return json.loads(body)
    except ValueError:
        # Битое тело — это 400 от FastAPI: разбирать в журнале нечего.
        return None


def client_ip(request: Request) -> str | None:
    """IP клиента: за nginx это `X-Real-IP`, дальше — первый `X-Forwarded-For`.

    Прямое подключение (без прокси) видно в `request.client`. Значение обрезается
    до длины колонки: заголовок задаёт клиент, а не мы.
    """
    forwarded = request.headers.get("x-real-ip")
    if not forwarded:
        chain = request.headers.get("x-forwarded-for", "")
        forwarded = chain.split(",")[0].strip()
    if not forwarded and request.client is not None:
        forwarded = request.client.host
    return forwarded[:IP_LIMIT] or None


def client_user_agent(request: Request) -> str | None:
    """`User-Agent` обрезается до настроенного потолка: его длину задаёт клиент."""
    value = request.headers.get("user-agent", "")
    return value[: get_settings().audit_user_agent_limit] or None


@asynccontextmanager
async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
    """На старте — месячные партиции журнала.

    Месяц без партиции означает потерянную запись журнала, а с fail-closed —
    ещё и отказ write-ручек. Поэтому партиции готовятся до первого запроса.

    Подготовка идемпотентна и делается один раз на процесс: повторный подъём
    приложения тем же процессом (а в тестах — каждый `TestClient`) не гоняет
    `CREATE TABLE IF NOT EXISTS` по тринадцати партициям заново.
    """
    if audit.month_guard():
        audit.refresh_audit_storage()
    yield


def create_app() -> FastAPI:
    """Приложение без CORS: фронт ходит на свой же origin, `/api` проксирует nginx."""
    application = FastAPI(
        title="CRM Dormitory API",
        version="0.1.0",
        description="Регистрация, вход и личный кабинет.",
        lifespan=lifespan,
    )

    @application.exception_handler(audit.AuditWriteError)
    async def audit_write_failed(_request: Request, error: audit.AuditWriteError) -> JSONResponse:
        """Журнал недоступен — действие не выполнено.

        503, а не 500: дело не в данных клиента, и запрос имеет смысл повторить.
        Текст уходит в `detail` — фронт показывает `detail` пользователю.
        """
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": str(error)},
        )

    @application.middleware("http")
    async def audit_middleware(request: Request, call_next: RequestResponseEndpoint) -> Response:
        """Собрать контекст запроса; строку журнала пишут коммит и конец запроса.

        Общий перехват здесь, а не в 86 ручках: ручки о журнале не знают и
        меняться не должны.

        Контекст создаётся до `call_next` и убирается после: всё, что успело
        закоммититься внутри обработки, кладёт свою строку журнала в тот же
        коммит (слушатель в `app.audit`), а если коммита не было — строка
        дописывается здесь, уже после ответа, с настоящим `status`.
        """
        settings = get_settings()
        if not settings.audit_enabled:
            return await call_next(request)
        # Смену месяца замечает первый запрос после неё: планировщика в задаче нет.
        if audit.month_guard():
            audit.refresh_audit_storage()

        body = await read_request_body(request)
        context = audit.AuditContext(
            request_id=str(uuid4()),
            method=request.method,
            scope=request.scope,
            ip=client_ip(request),
            user_agent=client_user_agent(request),
            request_body=(
                None
                if body is None
                else audit.truncate(audit.mask(audit.redact(body)), settings.audit_body_limit_bytes)
            ),
            started=time.perf_counter(),
            # Маршрут хранит путь без префикса включения: он нужен журналу, чтобы
            # собрать шаблон целиком (`/api/dormitories/{dormitory_id}`).
            prefix=API_PREFIX,
        )
        token = audit.start_context(context)
        try:
            response = await call_next(request)
        except Exception:
            # Ответа нет: наружу это станет 500 от сервера. Пишем строку, чтобы
            # падение ручки тоже было видно в журнале, и отдаём исключение дальше.
            audit.finish_context(token)
            audit.write_best_effort(context, status=UNHANDLED_ERROR_STATUS)
            raise
        audit.finish_context(token)
        audit.write_best_effort(context, status=response.status_code)
        return response

    application.include_router(health.router, prefix=API_PREFIX)
    application.include_router(auth.router, prefix=API_PREFIX)
    application.include_router(activation.router, prefix=API_PREFIX)
    application.include_router(recovery.router, prefix=API_PREFIX)
    application.include_router(users.router, prefix=API_PREFIX)
    application.include_router(organization.router, prefix=API_PREFIX)
    application.include_router(journal_router, prefix=API_PREFIX)
    application.include_router(dashboard.router, prefix=API_PREFIX)
    application.include_router(dashboard_blocks.router, prefix=API_PREFIX)
    application.include_router(report_readiness.router, prefix=API_PREFIX)
    application.include_router(hostels.router, prefix=API_PREFIX)
    application.include_router(inflow.router, prefix=API_PREFIX)
    application.include_router(outflow.router, prefix=API_PREFIX)
    application.include_router(payments.router, prefix=API_PREFIX)
    application.include_router(personnel.router, prefix=API_PREFIX)
    application.include_router(arrival_plans.router, prefix=API_PREFIX)
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
    application.include_router(solutions.router, prefix=API_PREFIX)
    application.include_router(billing.router, prefix=API_PREFIX)
    application.include_router(trial.router, prefix=API_PREFIX)
    application.include_router(documents.router, prefix=API_PREFIX)
    application.include_router(telegram.router, prefix=API_PREFIX)
    return application


app = create_app()
