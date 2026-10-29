"""Точка входа FastAPI."""

import json
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
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
from app.db import get_db
from app.file_access import can_read, content_type_for, normalize_key
from app.schemas.user import ErrorResponse
from app.security import OptionalUser
from app.storage import StorageNotFoundError, log_storage_mode, storage

API_PREFIX = "/api"

# Логи приложения видны в контейнере `api`. Uvicorn поднимает только свои
# логгеры (`uvicorn`, `uvicorn.error`, `uvicorn.access`), а корневой оставляет на
# WARNING — поэтому INFO самого проекта (режим файлового хранилища при импорте
# `app.storage`, сохранённые объекты S3, письма) в лог не попадал вовсе. Так же
# поступает бот (`app.bot.main`). `basicConfig` ничего не делает, если корневой
# логгер уже настроен, поэтому чужая конфигурация не ломается.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# Ключ хранилища в URL приходит без префикса `uploads/`:
# `/uploads/2026-10-29/<uuid>.xlsx`. Тексты отказов — часть контракта с
# клиентом: фронт их не показывает и не переписывает (отказ скачивания рисует
# браузер), но тестировщик сверяет их дословно.
UPLOAD_NOT_FOUND_DETAIL = "Файл не найден"
UPLOAD_FORBIDDEN_DETAIL = "Нет доступа к файлу"

# Описание отказов раздачи файлов для `responses=`: они и есть контракт.
UPLOAD_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_200_OK: {"description": "Байты файла, `Content-Type` по расширению"},
    status.HTTP_403_FORBIDDEN: {"model": ErrorResponse, "description": UPLOAD_FORBIDDEN_DETAIL},
    status.HTTP_404_NOT_FOUND: {"model": ErrorResponse, "description": UPLOAD_NOT_FOUND_DETAIL},
}

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

    Здесь же пишется режим файлового хранилища: при импорте модуля `app.storage`
    это было бы раньше настройки логирования, и строка терялась бы.
    """
    log_storage_mode()
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

    # -----------------------------------------------------------------------
    # Раздача загруженных файлов: `/uploads/<ключ>` читается через единый
    # механизм хранения (`app.storage`) — из S3 с префиксом среды либо с
    # локального диска. Ключ — без префикса `uploads/` (например
    # `2026-10-29/<uuid>.xlsx`). nginx проксирует `/uploads/` на этот адрес,
    # поэтому ссылка из SPA открывается тем же origin, что и сама страница.
    #
    # Маршрут живёт ВНЕ `/api` намеренно: это ссылка на файл, её открывает
    # браузер, и cookie сессии (`crm_session`, `path=/`) уходит сама.
    #
    # Доступ проверяется по умолчанию ЗАКРЫТО (`app/file_access.can_read`).
    # Аноним на закрытый файл получает 404 — само существование файла не
    # подтверждается; вошедший без прав — 403. Пустой ключ, ключ с `..` и
    # отсутствующий в хранилище объект дают тот же 404.
    # -----------------------------------------------------------------------
    @application.get(
        "/uploads/{key:path}",
        tags=["files"],
        response_class=Response,
        summary="Скачать загруженный файл",
        responses=UPLOAD_RESPONSES,
    )
    def get_upload(
        key: str,
        user: OptionalUser,
        db: Annotated[Session, Depends(get_db)],
    ) -> Response:
        """Отдать файл из хранилища. Право чтения считает `app.file_access`."""
        storage_key = normalize_key(key)
        if storage_key is None or user is None:
            # Аноним не узнаёт, существует ли файл: для него всё — 404.
            raise HTTPException(status.HTTP_404_NOT_FOUND, UPLOAD_NOT_FOUND_DETAIL)
        if not can_read(db, storage_key, user):
            raise HTTPException(status.HTTP_403_FORBIDDEN, UPLOAD_FORBIDDEN_DETAIL)
        try:
            data = storage.read_bytes(storage_key)
        except StorageNotFoundError:
            raise HTTPException(status.HTTP_404_NOT_FOUND, UPLOAD_NOT_FOUND_DETAIL) from None
        content_type = content_type_for(storage_key)
        return Response(
            content=data,
            media_type=content_type,
            headers={
                # Загруженный файл — документ: при открытии по прямой ссылке он
                # не должен исполнить скрипт на нашем origin. `nosniff` и
                # песочница это запрещают.
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                # Файл закрытый: копия не должна пережить отзыв доступа ни в
                # браузере, ни в общем прокси.
                "Cache-Control": "private, no-store",
            },
        )

    return application


app = create_app()
