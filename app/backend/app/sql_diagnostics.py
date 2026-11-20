"""Диагностика медленных SQL-запросов для всех API-маршрутов (issue #231).

Задача — ответить на вопрос «куда ушло время HTTP-запроса», не заводя трассировку
и не заводя вторую систему метрик. Механика одна и общая: она не привязана ни к
странице персонала, ни к конкретной ручке.

Три слоя, и у каждого своё назначение:

* **Контекст запроса** (`RequestSql` в `ContextVar`). Объект изменяемый, а не
  неизменяемое значение: middleware кладёт его один раз до `call_next`, а
  слушатели SQLAlchemy дописывают счётчик и время уже из того потока, где идёт
  выполнение. Так устроен и журнал действий (`app.audit`): синхронная ручка
  выполняется в threadpool, контекст туда копируется, а `ContextVar.set` оттуда
  наружу не выходит — мутация общего объекта выходит.
* **Слушатели SQLAlchemy** (`before_cursor_execute`/`after_cursor_execute`) на
  классе `Engine`, то есть для всех движков процесса: и для настоящей
  PostgreSQL, и для SQLite юнит-прогона, и для служебных сессий журнала. Вне
  запроса (`_current.get() is None`) они не делают ничего — бот, воркер импорта
  и планировщик остаются вне учёта.
* **Запись события в stdout** — одна строка JSON, только для запросов дольше
  порога. Её собирает promtail и разбирает Loki.
* **Разметка этапов** (`stage(name)` в обработчике). SQL-слой отвечает «сколько
  времени в базе», но не отвечает «куда ушло остальное»: загрузка строк,
  сборка ответа, планы, настройки. Этапы размечает сам обработчик — только он
  знает, где кончается один шаг и начинается другой, — а время копится в тот же
  `RequestSql` и попадает в событие полем `stages_ms`. Если обработчик ничего
  не разметил, поле остаётся пустым объектом.

Почему stdout-строка, а не `logging` с его форматом `%(asctime)s …`: Loki-запрос
`| json` разбирает строку целиком, а префикс `2026-11-19 12:00:00,000 INFO
app.sql_diagnostics:` сделал бы её невалидным JSON. Формат строки — контракт
дашборда (`monitor/grafana/dashboards/api.json`) и `docs/monitoring.md`.

**Приватность — главное ограничение этого модуля.** В событие не попадает ни
одно значение из базы:

* маршрут — только шаблон (`/api/dormitories/{dormitory_id}`), а не адрес
  запроса с идентификатором;
* SQL не пишется вовсе — ни сырой, ни «нормализованный»: `text()` в проекте
  собирается f-строками, и литерал в готовом стейтменте уже не отличить от
  имени колонки. Вместо SQL — безопасный стабильный fingerprint (12 hex от
  SHA-256 нормализованной формы) и имя операции;
* bind-параметры, тело запроса, cookies, `User-Agent` и полный URL не читаются
  вообще — их нет в `scope`, который видит `report`;
* в метках Prometheus нет ни fingerprint, ни `request_id`: кардинальность метки
  задаёт код, а не клиент.

Пороги (`SLOW_REQUEST_MS`, `SLOW_SQL_MS` в `app/config.py`) существуют именно
затем, чтобы подробного журнала всех запросов не было: пишется только медленное.

Найти SQL-шаблон по fingerprint можно офлайн-командой
`python -m app.diagnostics.sql_fingerprints` — она считает fingerprint по SQL из
кода, ничего не выполняя в базе. Как расследовать — `docs/monitoring.md`.
"""

import hashlib
import json
import logging
import re
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, Final
from uuid import uuid4

from prometheus_client import Counter, Histogram
from sqlalchemy import event
from sqlalchemy.engine import Connection, Engine
from starlette.middleware.base import RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import Scope

from app import metrics
from app.config import get_settings

logger = logging.getLogger(__name__)

# Имя события в stdout. По нему строится Loki-запрос панели и его же проверяют
# тесты; менять его — значит менять контракт дашборда.
EVENT_NAME: Final = "slow_sql_request"
# Диагностика клиентского API: всё, что живёт под `/api`, и ничего больше.
# `/metrics` вычитается отдельно, хотя под `/api` и не лежит: правило названо
# явно, чтобы скрейп не начал считаться при смене префикса.
CLIENT_API_PREFIX: Final = "/api"
# Ответа нет — наружу это станет 500 от сервера; в событии тот же код.
UNHANDLED_STATUS: Final = 500
# Сколько SQL-шаблонов перечисляется в событии. Медленных шаблонов в одном
# запросе бывает много, а разбирают обычно верхушку.
REPORTED_TEMPLATES: Final = 5
# Сколько размеченных этапов обработчика попадает в событие. Этапы, которых
# коснулся обработчик, называет код (`stage(...)`), поэтому их число задаёт код, а
# не клиент; потолок нужен, чтобы событие не превращалось в профиль на сотню
# ключей. В событие идут самые долгие этапы — отбор по убыванию времени.
STAGES_LIMIT: Final = 8
# Потолок числа шаблонов в одном запросе. Достижим только на сгенерированном
# SQL: суммарные счётчик и время при этом считаются по-прежнему точно.
TEMPLATES_LIMIT: Final = 200
# Длина fingerprint в hex-символах: 48 бит. Коллизия внутри одной базы кода
# практически невозможна, а строка остаётся читаемой в логе.
FINGERPRINT_LENGTH: Final = 12

# Метрики SQL живут рядом с метриками HTTP, но отдельными именами: контракт
# `http_requests_total`/`http_request_duration_seconds`/`db_size_bytes` (#213)
# этой задачей не меняется. Метки те же две — метод и шаблон маршрута. Это
# ответ на вопрос «сколько времени запроса ушло в SQL», а не «какой SQL
# медленный»: медленный шаблон виден в событии и по fingerprint в логах.
SQL_DURATION = Histogram(
    "http_request_sql_duration_seconds",
    "Суммарное время SQL-выполнений за HTTP-запрос",
    ["method", "route"],
    buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
)
SQL_STATEMENTS = Counter(
    "http_sql_statements_total",
    "SQL-выполнений за HTTP-запрос",
    ["method", "route"],
)

# --- Нормализация SQL -------------------------------------------------------
# Литералы вырезаются ДО хеширования, поэтому одно и то же место в коде даёт
# один и тот же fingerprint при любых значениях параметров.
#
# Порядок важен: сначала dollar-quoted строки PostgreSQL ($$…$$ и $tag$…$tag$),
# потом обычные литералы со удвоенной кавычкой внутри, потом метки параметров,
# потом числа. Метки параметров приводятся к одному виду намеренно: SQL из кода
# приходит с `:name`, а в базу уходит уже собранным — `%(name)s` у psycopg и `?`
# у SQLite. Без этой нормализации fingerprint одного и того же места в коде не
# совпал бы между кодом и событием, а `python -m app.diagnostics.sql_fingerprints`
# не нашёл бы ничего.
_DOLLAR_QUOTED = re.compile(r"\$(?P<tag>[A-Za-z_]\w*)?\$.*?\$(?P=tag)\$", re.DOTALL)
_STRING_LITERAL = re.compile(r"[eEbBxXnN]?'(?:[^'\\]|\\.|'')*'")
# `%(name)s` у psycopg, `:name` у SQLAlchemy (но не `::type` — это приведение
# типа PostgreSQL), `$1` у asyncpg и `?` у SQLite и psycopg-с-позиционными.
_BIND_PARAM = re.compile(r"%\(\w+\)s|(?<![:%]):\w+|(?<![\w$])\$\d+|(?<![\w?])\?")
_NUMBER = re.compile(r"(?<![\w.$?])[+-]?\d+(?:\.\d+)?(?![\w.])")
_IN_LIST = re.compile(r"\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)", re.IGNORECASE)
_WHITESPACE = re.compile(r"\s+")

# Операции, по которым читают событие: первое слово стейтмента.
_OPERATIONS: Final = frozenset(
    {
        "select",
        "insert",
        "update",
        "delete",
        "with",
        "set",
        "show",
        "explain",
        "begin",
        "commit",
        "rollback",
        "savepoint",
        "release",
        "create",
        "alter",
        "drop",
        "analyze",
        "vacuum",
        "copy",
        "merge",
        "call",
        "do",
    }
)
_OTHER_OPERATION: Final = "OTHER"

# Имена таблиц — идентификаторы, а не значения: они безопасны и очень помогают
# при разборе события. Берутся только из явных мест стейтмента.
_TABLE_PATTERNS: Final = (
    re.compile(r"\bfrom\s+([a-z_][\w.]*)", re.IGNORECASE),
    re.compile(r"\bjoin\s+([a-z_][\w.]*)", re.IGNORECASE),
    re.compile(r"\binto\s+([a-z_][\w.]*)", re.IGNORECASE),
    re.compile(r"\bupdate\s+([a-z_][\w.]*)", re.IGNORECASE),
)
TABLES_LIMIT: Final = 4


def normalize(statement: str) -> str:
    """SQL без значений: литералы заменены на `?`, пробелы схлопнуты.

    Функция пригодна и для человека: по нормализованной форме шаблон ищут в
    коде. Наружу из приложения она не отдаётся — в событие уходит только
    fingerprint, потому что литерал в SQL из `text()` от имени колонки не
    отличить автоматически ни при каком разборе.
    """
    text = _DOLLAR_QUOTED.sub("?", statement)
    text = _STRING_LITERAL.sub("?", text)
    text = _BIND_PARAM.sub("?", text)
    text = _NUMBER.sub("?", text)
    text = _IN_LIST.sub("in (?)", text)
    return _WHITESPACE.sub(" ", text).strip()


def _fingerprint_of(normalized: str) -> str:
    """Отпечаток уже нормализованной формы SQL."""
    return hashlib.sha256(normalized.encode()).hexdigest()[:FINGERPRINT_LENGTH]


def fingerprint(statement: str) -> str:
    """Стабильный безопасный отпечаток шаблона SQL.

    Считается от нормализованной формы, поэтому не зависит ни от значений
    параметров, ни от форматирования исходного SQL. Одинаков для всех версий
    приложения, пока не изменился сам шаблон — это и позволяет сравнивать
    событие с SQL из кода.
    """
    return _fingerprint_of(normalize(statement))


@dataclass(frozen=True)
class _Analysis:
    """Разобранный шаблон: то, что можно показать в событии без риска."""

    fingerprint: str
    operation: str
    tables: tuple[str, ...]


@lru_cache(maxsize=1024)
def analyze(statement: str) -> _Analysis:
    """Разобрать SQL. Кеш на процессе: разбор повторяется на каждом выполнении.

    Кеш ограничен (`maxsize`) и инвалидируется целиком по переполнению — значений
    в нём нет, только текст стейтмента и его отпечаток. Память под него
    ограничена сверху самим размером SQL.
    """
    normalized = normalize(statement)
    head = normalized.split(" ", 1)[0].lower() if normalized else ""
    operation = head.upper() if head in _OPERATIONS else _OTHER_OPERATION
    tables: list[str] = []
    for pattern in _TABLE_PATTERNS:
        for match in pattern.finditer(normalized):
            name = match.group(1).strip('"').lower()
            if name and name not in tables:
                tables.append(name)
    return _Analysis(
        fingerprint=_fingerprint_of(normalized),
        operation=operation,
        tables=tuple(sorted(tables)[:TABLES_LIMIT]),
    )


# --- Контекст запроса -------------------------------------------------------


@dataclass
class TemplateStats:
    """Что накопилось по одному SQL-шаблону за один HTTP-запрос.

    `slowest_at_ms` — смещение самого долгого выполнения от начала запроса: по
    нему отдельное выполнение сопоставляется и с запросом, и с местом в коде
    (какая часть ручки его вызвала).
    """

    fingerprint: str
    operation: str
    tables: tuple[str, ...]
    count: int = 0
    total_ms: float = 0.0
    max_ms: float = 0.0
    slowest_at_ms: float = 0.0


@dataclass
class RequestSql:
    """SQL, выполненный внутри одного HTTP-запроса.

    Объект изменяемый, и это не небрежность: middleware создаёт его в
    asyncio-контексте, а выполнения приходят из threadpool синхронных ручек.
    `ContextVar.set` там наружу не выходит, а мутация общего объекта видна
    всем — так же устроен `audit.AuditContext`.
    """

    request_id: str
    # `time.perf_counter()` начала запроса: смещения считаются от него.
    started: float
    count: int = 0
    total_ms: float = 0.0
    templates: dict[str, TemplateStats] = field(default_factory=dict)
    # Размеченные этапы обработчика: имя этапа задаёт код, время копится по имени.
    # Имена этапов — идентификаторы из кода, а не значения из базы, поэтому они
    # безопасны для события.
    stages_ms: dict[str, float] = field(default_factory=dict)

    def add(self, statement: str, duration_ms: float, offset_ms: float) -> None:
        """Учесть одно выполнение. Счётчик и время суммируются всегда."""
        analysis = analyze(statement)
        self.count += 1
        self.total_ms += duration_ms
        stats = self.templates.get(analysis.fingerprint)
        if stats is None:
            if len(self.templates) >= TEMPLATES_LIMIT:
                return
            stats = TemplateStats(
                fingerprint=analysis.fingerprint,
                operation=analysis.operation,
                tables=analysis.tables,
            )
            self.templates[analysis.fingerprint] = stats
        stats.count += 1
        stats.total_ms += duration_ms
        if duration_ms > stats.max_ms:
            stats.max_ms = duration_ms
            stats.slowest_at_ms = offset_ms

    def add_stage(self, name: str, duration_ms: float) -> None:
        """Учесть время этапа: повторный заход в тот же этап суммируется."""
        self.stages_ms[name] = self.stages_ms.get(name, 0.0) + duration_ms


# Контекст текущего запроса. Задача запроса его наследует, threadpool
# синхронных ручек — тоже (anyio копирует контекст на момент вызова).
_current: ContextVar[RequestSql | None] = ContextVar("sql_diagnostics", default=None)


def current() -> RequestSql | None:
    """Учёт текущего запроса или `None` вне запроса."""
    return _current.get()


def start_request(request_id: str) -> Token[RequestSql | None]:
    """Начать учёт. Возвращённый маркер нужен для `finish_request`."""
    return _current.set(RequestSql(request_id=request_id, started=time.perf_counter()))


def finish_request(token: Token[RequestSql | None]) -> None:
    """Закрыть учёт: контекст не течёт в следующий запрос."""
    _current.reset(token)


@contextmanager
def stage(name: str) -> Iterator[None]:
    """Разметить этап обработчика: его время попадёт в `stages_ms` события.

    Вызов из кода, а не из middleware: только обработчик знает, где кончается
    загрузка строк-источников и начинается сборка ответа. Вне запроса (бот,
    воркер импорта, тест без middleware) это no-op — исключений не бросает и
    ничего не копит, поэтому разметку можно ставить в доменном коде.

    `finally` обязателен: исключение внутри этапа не должно оставлять этап
    открытым и не должно съедать уже измеренное время.
    """
    request_sql = _current.get()
    if request_sql is None:
        yield
        return
    started = time.perf_counter()
    try:
        yield
    finally:
        request_sql.add_stage(name, (time.perf_counter() - started) * 1000)


# --- Слушатели SQLAlchemy ---------------------------------------------------
# Отметка начала хранится на соединении, а не стеком: на одном соединении
# стейтменты идут строго по очереди, а вызов `before` без парного `after`
# (ошибка базы: `after_cursor_execute` в этом случае не срабатывает) оставил бы
# в стеке мусор — и следующее выполнение получило бы чужую, завышенную
# длительность. Одна ячейка перезаписывается, поэтому мусор невозможен.
_START_KEY: Final = "sql_diagnostics_started"


@event.listens_for(Engine, "before_cursor_execute")
def _remember_start(
    conn: Connection,
    cursor: Any,
    statement: str,
    parameters: Any,
    context: Any,
    executemany: bool,
) -> None:
    """Запомнить момент начала выполнения — только внутри учитываемого запроса."""
    if _current.get() is None:
        return
    conn.info[_START_KEY] = time.perf_counter()


@event.listens_for(Engine, "after_cursor_execute")
def _record_execution(
    conn: Connection,
    cursor: Any,
    statement: str,
    parameters: Any,
    context: Any,
    executemany: bool,
) -> None:
    """Учесть выполнение: время, шаблон и место в запросе.

    `parameters` и `cursor` не читаются намеренно: значения параметров — это
    персональные данные, и в диагностику они не попадают ни при каких условиях.
    """
    started = conn.info.pop(_START_KEY, None)
    if started is None:
        return
    request_sql = _current.get()
    if request_sql is None:
        return
    now = time.perf_counter()
    request_sql.add(
        statement,
        (now - started) * 1000,
        (started - request_sql.started) * 1000,
    )


# --- Middleware и запись события -------------------------------------------


def measured(path: str) -> bool:
    """Считать ли запрос: клиентский API, но не `/metrics`.

    Скрейп считается отдельно и живёт вне `/api`, поэтому в учёт SQL не попадает
    ни сам он, ни `SELECT pg_database_size`, который `/metrics` выполняет: без
    этого правила служебный запрос раз в 15 с выглядел бы работой клиента.
    """
    return path != metrics.METRICS_PATH and path.startswith(CLIENT_API_PREFIX)


def slow_request_threshold_ms() -> int:
    """Порог «запрос медленный», мс. Читается из настроек, а не из литерала."""
    return get_settings().slow_request_ms


def slow_sql_threshold_ms() -> int:
    """Порог «SQL-шаблон медленный», мс: ниже него шаблон в событие не идёт."""
    return get_settings().slow_sql_ms


def stages_breakdown(request_sql: RequestSql) -> dict[str, float]:
    """Разбивка по этапам для события: самые долгие, не больше `STAGES_LIMIT`.

    Порядок — по убыванию времени: отбор идёт по нему же, поэтому в событие
    попадают именно те этапы, из-за которых запрос медленный, а быстрые
    отбрасываются. Имена этапов задаёт код, значений из базы здесь нет.
    """
    order = sorted(request_sql.stages_ms.items(), key=lambda item: item[1], reverse=True)
    return {name: round(duration_ms, 1) for name, duration_ms in order[:STAGES_LIMIT]}


def build_event(
    request_sql: RequestSql,
    *,
    method: str,
    route: str,
    status: int,
    duration_ms: float,
    failed: bool,
) -> dict[str, Any]:
    """Событие медленного запроса: всё, что можно показать, и ничего лишнего.

    Ровно эти поля разбирают дашборд и инструкция `docs/monitoring.md`, поэтому
    набор полей — контракт, а не подробность реализации.
    """
    request_threshold = slow_request_threshold_ms()
    sql_threshold = slow_sql_threshold_ms()
    slow = [stats for stats in request_sql.templates.values() if stats.max_ms >= sql_threshold]
    slow.sort(key=lambda stats: stats.total_ms, reverse=True)
    return {
        "event": EVENT_NAME,
        "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
        "request_id": request_sql.request_id,
        "method": method,
        "route": route,
        "status": status,
        "failed": failed,
        "duration_ms": round(duration_ms, 1),
        "sql_ms": round(request_sql.total_ms, 1),
        "sql_count": request_sql.count,
        # Доля SQL во времени запроса: если она мала, причина медленности не в
        # базе, и это видно прямо в событии, без сверки двух графиков.
        "sql_share": round(request_sql.total_ms / duration_ms, 3) if duration_ms > 0 else 0.0,
        # Время этапов обработчика: остаток «duration_ms минус sql_ms минус этапы»
        # — это то, чего не видит ни SQL-слой, ни разметка (пул соединений,
        # flush/commit, сериализация ответа). Этапы, которые обработчик не
        # размечал, в событие не попадают вовсе.
        "stages_ms": stages_breakdown(request_sql),
        "thresholds": {"request_ms": request_threshold, "sql_ms": sql_threshold},
        "slow_sql": [
            {
                "fingerprint": stats.fingerprint,
                "operation": stats.operation,
                "tables": list(stats.tables),
                "count": stats.count,
                "total_ms": round(stats.total_ms, 1),
                "max_ms": round(stats.max_ms, 1),
                "slowest_at_ms": round(stats.slowest_at_ms, 1),
            }
            for stats in slow[:REPORTED_TEMPLATES]
        ],
    }


def write_event(payload: dict[str, Any]) -> None:
    """Записать событие одной строкой JSON в stdout.

    `sort_keys` — чтобы одинаковые события были побайтово одинаковыми, а
    `separators` без пробелов — чтобы строка была короче и однозначнее для
    Loki. Закрытый или переполненный stdout не повод ронять запрос клиента:
    диагностика молча пропускается, ответ уходит как обычно.
    """
    line = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except (OSError, ValueError):
        return


def report(
    scope: Scope,
    request_sql: RequestSql,
    *,
    status_code: int,
    duration_ms: float,
    failed: bool,
) -> None:
    """Отдать метрики запроса и, если он медленный, записать событие.

    Метрики пишутся всегда (по ним считается доля SQL во времени ответа), а
    событие — только выше порога: журнала всех запросов нет намеренно.
    """
    method = str(scope.get("method", ""))
    route = metrics.route_template(scope)
    SQL_DURATION.labels(method=method, route=route).observe(request_sql.total_ms / 1000)
    SQL_STATEMENTS.labels(method=method, route=route).inc(request_sql.count)
    if duration_ms < slow_request_threshold_ms():
        return
    write_event(
        build_event(
            request_sql,
            method=method,
            route=route,
            status=status_code,
            duration_ms=duration_ms,
            failed=failed,
        )
    )


async def middleware(request: Request, call_next: RequestResponseEndpoint) -> Response:
    """Учесть SQL каждого клиентского запроса — независимо от `AUDIT_ENABLED`.

    Контекст ставится до `call_next` и снимается после ответа, в `finally`:
    исключение ручки контекст не оставляет, а соседний запрос не получает чужой
    счётчик. Падение ручки считается как `500` и не глотается — ответ на него
    формирует обработчик ошибок Starlette.
    """
    if not measured(request.scope["path"]):
        return await call_next(request)
    started = time.perf_counter()
    request_sql = RequestSql(request_id=str(uuid4()), started=started)
    token = _current.set(request_sql)
    status_code = UNHANDLED_STATUS
    failed = False
    try:
        response = await call_next(request)
    except Exception:
        failed = True
        raise
    else:
        status_code = response.status_code
        return response
    finally:
        _current.reset(token)
        try:
            report(
                request.scope,
                request_sql,
                status_code=status_code,
                duration_ms=(time.perf_counter() - started) * 1000,
                failed=failed,
            )
        except Exception:  # pragma: no cover - диагностика не роняет запрос
            # Запись диагностики не имеет права превратить успешный ответ в 500
            # или подменить исключение ручки своим.
            logger.exception("Диагностика SQL не записана")
