"""Метрики Prometheus: RPS, статусы ответов, латентность и размер базы.

`/metrics` — не клиентский контракт, а служебный вход для Prometheus: он живёт
**вне** `/api`, не попадает в `openapi.json` и снаружи не публикуется — его
читает Prometheus внутри сети compose по адресу `api:8000`. nginx фронта
проксирует только `/api/`, поэтому метрики в интернет не уходят.

Две вещи решают, что попадёт в метку `route`, и обе — про кардинальность:

* маршрут берётся из `scope["route"]`, то есть **шаблон**
  (`/api/dormitories/{dormitory_id}`), а не путь запроса: идентификатор в метке
  означал бы новую серию на каждый запрос и взорвал бы память Prometheus;
* запрос, не сопоставленный ни с одним маршрутом (404), получает `unmatched`:
  путь целиком в метку не попадает — его задаёт клиент.

Самоскрейп `/metrics` не считается вовсе: Prometheus ходит туда раз в 15 с, и
без этого исключения он сам портил бы и RPS, и латентность в собственных
графиках.
"""

import logging
import time
from typing import Final

from prometheus_client import Counter, Gauge, Histogram, generate_latest
from sqlalchemy import text
from starlette.middleware.base import RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import Scope

from app import db as db_module

logger = logging.getLogger(__name__)

# Путь, который не считается. Ровно он стоит в маршруте `app.main`.
METRICS_PATH: Final = "/metrics"
# Метка маршрута для запроса, не сопоставленного ни с одной ручкой.
UNMATCHED_ROUTE: Final = "unmatched"
# Ответа нет — наружу это станет 500 от сервера; в метрике тот же код.
UNHANDLED_STATUS: Final = "500"
# Формат ответа заморожен контрактом шва «приложение ↔ Prometheus»:
# `text/plain; version=0.0.4`. В `prometheus-client` 0.26 `CONTENT_TYPE_LATEST`
# переехал на `text/plain; version=1.0.0`, поэтому тип задан здесь явно — смена
# библиотеки не должна молча менять контракт `/metrics`.
CONTENT_TYPE_PROMETHEUS: Final = "text/plain; version=0.0.4; charset=utf-8"

REQUESTS = Counter(
    "http_requests_total",
    "Всего HTTP-запросов",
    ["method", "status", "route"],
)
DURATION = Histogram(
    "http_request_duration_seconds",
    "Длительность HTTP-запроса",
    ["method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
)
DB_SIZE = Gauge("db_size_bytes", "Размер текущей базы")

# Размер базы — дорогой запрос к каталогу PostgreSQL, а смотрят его раз в 15 с.
# Поэтому он обновляется лениво: не чаще раза в 30 с и только на скрейпе.
DB_SIZE_INTERVAL_SECONDS: Final = 30.0
# Стенд может быть без базы вовсе. Тогда WARNING нужен, но не на каждый скрейп.
DB_SIZE_WARNING_INTERVAL_SECONDS: Final = 60.0
# Ограничение времени запроса: размер базы не должен держать скрейп.
DB_SIZE_STATEMENT_TIMEOUT: Final = "5s"

# Монотонные отметки последних попыток: часы процесса, а не календарь.
_last_db_size_check: float | None = None
_last_db_size_warning: float | None = None

# Ключ, под которым FastAPI 0.16x держит в `scope` контекст фактического
# маршрута: `include_router` кладёт роутер обёрткой, и `scope["route"]` внутри
# неё хранит путь **без** префикса включения (`/health` вместо `/api/health`).
FASTAPI_SCOPE_KEY: Final = "fastapi"
EFFECTIVE_ROUTE_KEY: Final = "effective_route_context"


def _template_of(route: object) -> str | None:
    """Шаблон пути из маршрута: `path_format` без конвертеров, иначе `path`."""
    for attribute in ("path_format", "path"):
        value = getattr(route, attribute, None)
        if isinstance(value, str) and value:
            return value
    return None


def route_template(scope: Scope) -> str:
    """Шаблон маршрута; ничего не сопоставлено — `unmatched`.

    Сначала берётся контекст фактического маршрута FastAPI: только он знает
    полный путь вместе с префиксом `include_router`. `scope["route"]` — запасной
    путь: он есть у маршрутов, объявленных прямо на приложении (`/uploads/...`,
    `/metrics`), и у версий, где роутер не оборачивает включённые.

    Оба значения — **шаблоны** (`/api/dormitories/{dormitory_id}`), а не пути
    запросов: идентификатор в метке дал бы новую серию на каждый запрос.
    """
    fastapi_scope = scope.get(FASTAPI_SCOPE_KEY)
    if isinstance(fastapi_scope, dict):
        template = _template_of(fastapi_scope.get(EFFECTIVE_ROUTE_KEY))
        if template is not None:
            return template
    template = _template_of(scope.get("route"))
    return UNMATCHED_ROUTE if template is None else template


def observe(method: str, route: str, status: str, duration: float) -> None:
    """Записать один запрос: счётчик по статусу и наблюдение в гистограмму."""
    REQUESTS.labels(method=method, status=status, route=route).inc()
    DURATION.labels(method=method, route=route).observe(duration)


async def middleware(request: Request, call_next: RequestResponseEndpoint) -> Response:
    """Считать каждый запрос — независимо от `AUDIT_ENABLED`.

    Middleware регистрируется в `app.main` последним: в Starlette последний
    добавленный оказывается внешним, поэтому ответ здесь такой, каким его
    отдала ручка, а не переписанный внутренними слоями.

    Падение ручки считается как `500`: ответа нет, но клиент получит 500 от
    сервера, и метрика обязана совпасть с тем, что видно снаружи. Исключение
    не глотается — оно уходит дальше, к обработчику ошибок Starlette.
    """
    if request.scope["path"] == METRICS_PATH:
        return await call_next(request)
    method = request.method
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        observe(
            method,
            route_template(request.scope),
            UNHANDLED_STATUS,
            time.perf_counter() - started,
        )
        raise
    observe(
        method,
        route_template(request.scope),
        str(response.status_code),
        time.perf_counter() - started,
    )
    return response


def query_db_size_bytes() -> int:
    """`pg_database_size(current_database())` с ограничением времени запроса."""
    with db_module.SessionLocal() as session:
        # `SET LOCAL` действует до конца транзакции: сессия открывает её сама,
        # а размер базы считается в ней же.
        session.execute(text(f"SET LOCAL statement_timeout = '{DB_SIZE_STATEMENT_TIMEOUT}'"))
        value: int = session.execute(
            text("SELECT pg_database_size(current_database())")
        ).scalar_one()
    return value


def refresh_db_size(now: float | None = None) -> None:
    """Обновить `db_size_bytes` лениво — не чаще раза в 30 с.

    Ошибка базы `/metrics` не роняет: остаётся прошлое значение, а в лог уходит
    WARNING не чаще раза в минуту. Стенд без базы (и юнит-прогон на SQLite,
    где нет `pg_database_size`) — штатный случай, а не повод отдавать 500 на
    скрейп, поэтому ловится любая ошибка, а не только ошибка SQLAlchemy.
    """
    global _last_db_size_check, _last_db_size_warning

    moment = time.monotonic() if now is None else now
    if _last_db_size_check is not None and moment - _last_db_size_check < DB_SIZE_INTERVAL_SECONDS:
        return
    _last_db_size_check = moment
    try:
        value = query_db_size_bytes()
    except Exception as error:
        if (
            _last_db_size_warning is None
            or moment - _last_db_size_warning >= DB_SIZE_WARNING_INTERVAL_SECONDS
        ):
            _last_db_size_warning = moment
            logger.warning("Размер базы для метрики db_size_bytes не прочитан: %s", error)
        return
    DB_SIZE.set(value)


def exposition() -> Response:
    """Отдать текущие метрики в текстовом формате Prometheus."""
    refresh_db_size()
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_PROMETHEUS)
