"""Notifier: алерты Alertmanager → Telegram и вечерняя сводка за сутки.

Один процесс, три входа:

* ``POST /alert`` — webhook Alertmanager: приходит JSON, уходит сообщение в
  Telegram (или строка в лог, если токен не задан);
* ``POST /digest`` — собрать и отправить сводку немедленно: так её проверяют
  руками, не дожидаясь ``DIGEST_HOUR``;
* фоновый поток — та же сводка раз в сутки в ``DIGEST_HOUR`` по
  ``DIGEST_TIMEZONE`` (по умолчанию 18:00 Europe/Moscow).

Цифры берутся из Prometheus (``PROMETHEUS_URL``), а не из собственной базы:
notifier ничего не хранит и приложение не опрашивает. Если Prometheus молчит,
сводка всё равно уходит — в ней честно написано «нет данных», а не нули.

Сеть наружу — только Bot API. Пустой ``MONITOR_TELEGRAM_BOT_TOKEN`` —
рабочее состояние: сообщение попадает в лог (в том числе строка со словом
``АЛЕРТ``), процесс не падает. Если у сервера нет прямого выхода в Telegram,
``MONITOR_TELEGRAM_PROXY_URL`` уводит в прокси только отправку в Bot API:
запросы к Prometheus остаются прямыми (issue #232).

``parse_mode`` не используется: в тексте алертов и сводки встречаются ``<``,
``_`` и ``*``, а экранировать их в каждом сообщении — источник ошибок.
Telegram показывает такой текст как есть.

Токен бота в лог не попадает никогда: адрес Bot API содержит его, поэтому при
ошибке пишется только тип исключения (так же сделано в
``app/backend/app/telegram.py``).
"""

import json
import logging
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

logger = logging.getLogger("notifier")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

TELEGRAM_API_BASE_URL = os.environ.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org")
BOT_TOKEN = os.environ.get("MONITOR_TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("MONITOR_TELEGRAM_CHAT_ID", "")
# Прокси только для Bot API. Пустое значение — прямое соединение. Через прокси
# не ходят запросы к Prometheus: они идут по внутренней сети compose, и прокси
# там только мешал бы. Значение содержит логин и пароль — в лог оно не попадает.
TELEGRAM_PROXY_URL = os.environ.get("MONITOR_TELEGRAM_PROXY_URL", "").strip()
PROMETHEUS_URL = os.environ.get("PROMETHEUS_URL", "http://prometheus:9090")

# Час вечерней сводки и её часовой пояс. Часовой пояс — отдельной переменной:
# контейнер запускается с TZ=Europe/Moscow, но полагаться только на TZ нельзя —
# в slim-образе может не оказаться базы часовых поясов.
DIGEST_HOUR = int(os.environ.get("DIGEST_HOUR", "18"))
DIGEST_TIMEZONE = os.environ.get("DIGEST_TIMEZONE") or os.environ.get("TZ") or "Europe/Moscow"
# Если базы часовых поясов в образе нет: Москва — UTC+3 круглый год.
FALLBACK_TZ_OFFSET_HOURS = 3
# Как часто поток проверяет, не наступил ли час сводки.
DIGEST_CHECK_INTERVAL_SECONDS = 30
# Потолок одного запроса: сводка не должна висеть на молчащем Prometheus.
HTTP_TIMEOUT_SECONDS = 10

# Запросы к Prometheus. Имена метрик заморожены контрактом шва
# «приложение ↔ Prometheus» и совпадают с app/backend/app/metrics.py.
QUERY_REQUESTS = 'sum(increase(http_requests_total{job="api"}[24h]))'
QUERY_ERRORS = 'sum(increase(http_requests_total{job="api",status=~"5.."}[24h]))'
QUERY_P95 = (
    "histogram_quantile(0.95, sum by (le) "
    '(rate(http_request_duration_seconds_bucket{job="api"}[24h])))'
)
QUERY_CPU = 'topk(3, avg_over_time(container_cpu_percent{service!=""}[24h]))'
QUERY_MEMORY = 'topk(3, avg_over_time(container_memory_usage_bytes{service!=""}[24h]))'
FILESYSTEM_FILTER = 'mountpoint="/",fstype!~"tmpfs|devtmpfs|overlay|squashfs"'
QUERY_DISK_FREE = (
    f'node_filesystem_avail_bytes{{job="node-exporter",{FILESYSTEM_FILTER}}} / '
    f'node_filesystem_size_bytes{{job="node-exporter",{FILESYSTEM_FILTER}}}'
)
QUERY_DB_SIZE = 'db_size_bytes{job="api"}'
QUERY_DOWN = "up == 0"
QUERY_STOPPED = 'time() - container_last_seen{service!=""} > 60'


class AlertItem(BaseModel):
    """Один алерт из webhook Alertmanager. Поля необязательны: формат внешний."""

    labels: dict[str, str] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)


class Webhook(BaseModel):
    """Тело POST /alert (стандартный webhook Alertmanager)."""

    status: str = ""
    alerts: list[AlertItem] = Field(default_factory=list)


def _timezone() -> tzinfo:
    """Часовой пояс сводки; без базы часовых поясов — фиксированное смещение."""
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(DIGEST_TIMEZONE)
    except Exception:  # отсутствие tzdata — не ошибка конфигурации, а среда без базы зон
        return timezone(timedelta(hours=FALLBACK_TZ_OFFSET_HOURS))


def telegram_opener() -> urllib.request.OpenerDirector | None:
    """Opener для Bot API: свой прокси, если он задан, иначе ``None``.

    ``None`` — прямое соединение прежним ``urllib.request.urlopen``. Отдельный
    opener, а не глобальный ``urllib.request.install_opener``: через прокси идёт
    только разговор с Telegram, а сводка ходит в Prometheus по внутренней сети
    compose, где прокси не нужен (issue #232).
    """
    if not TELEGRAM_PROXY_URL:
        return None
    proxy = urllib.request.ProxyHandler({"http": TELEGRAM_PROXY_URL, "https": TELEGRAM_PROXY_URL})
    return urllib.request.build_opener(proxy)


def _request(
    url: str,
    data: bytes | None = None,
    *,
    opener: urllib.request.OpenerDirector | None = None,
) -> Any:
    """GET (или POST с телом) и разбор JSON. Исключения — наружу.

    ``opener`` передаётся только для Bot API: так один и тот же разбор ответа
    работает и через прокси, и напрямую. Прямое соединение — прежний
    ``urllib.request.urlopen``, у него и у ``OpenerDirector.open`` одинаковый
    вызов, поэтому разбор ответа ниже один.
    """
    request = urllib.request.Request(url, data=data)
    open_request = urllib.request.urlopen if opener is None else opener.open
    with open_request(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def query(expression: str) -> list[dict[str, Any]]:
    """Мгновенный запрос к Prometheus. Ошибка — пустой результат и WARNING.

    Сводка не должна падать из-за недоступного Prometheus: пустой список
    означает «нет данных», и это честно написано в тексте.
    """
    url = f"{PROMETHEUS_URL.rstrip('/')}/api/v1/query?" + urllib.parse.urlencode(
        {"query": expression}
    )
    try:
        payload = _request(url)
    except Exception as error:  # сеть и разбор JSON одинаково не критичны для сводки
        logger.warning("Prometheus не ответил на запрос %r: %s", expression, type(error).__name__)
        return []
    if payload.get("status") != "success":
        logger.warning("Prometheus вернул %r на запрос %r", payload.get("status"), expression)
        return []
    return list(payload.get("data", {}).get("result", []))


def _number(value: Any) -> float | None:
    """Число из строки Prometheus. NaN/Inf и мусор — ``None`` (нет данных)."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def _single(expression: str) -> float | None:
    """Одно число из мгновенного запроса."""
    result = query(expression)
    if not result:
        return None
    return _number(result[0].get("value", [None, None])[1])


def _count(value: float | None) -> str:
    """Количество без дробной части: 12 345."""
    if value is None:
        return "нет данных"
    return f"{round(value):,}".replace(",", " ")


def _percent(value: float | None) -> str:
    """Доля 0…1 как процент."""
    if value is None:
        return "нет данных"
    return f"{value * 100:.1f} %"


def _mebibytes(value: float | None) -> str:
    """Байты как МиБ или ГиБ — смотря что читается лучше."""
    if value is None:
        return "нет данных"
    if value >= 1024**3:
        return f"{value / 1024**3:.1f} ГиБ"
    return f"{value / 1024**2:.0f} МиБ"


def _milliseconds(value: float | None) -> str:
    """Секунды как миллисекунды."""
    if value is None:
        return "нет данных"
    return f"{value * 1000:.0f} мс"


def _top(expression: str, unit: str, scale: float, digits: int) -> str:
    """Топ-3 контейнера по величине: «api 12.0 %, web 0.4 %»."""
    result = query(expression)
    if not result:
        return "нет данных"
    parts = []
    for item in result:
        name = item.get("metric", {}).get("service") or item.get("metric", {}).get("name") or "?"
        value = _number(item.get("value", [None, None])[1])
        if value is None:
            continue
        parts.append(f"{name} {value * scale:.{digits}f} {unit}")
    return ", ".join(parts) if parts else "нет данных"


def alert_text(payload: Webhook) -> str:
    """Текст сообщения об алертах. Чистая функция, без сети."""
    firing = payload.status == "firing"
    lines = ["🚨 АЛЕРТ" if firing else "✅ Восстановлено"]
    for item in payload.alerts:
        name = item.labels.get("alertname", "?")
        summary = item.annotations.get("summary", "")
        line = f"• {name}: {summary}" if summary else f"• {name}"
        details = [
            f"{key}={item.labels[key]}"
            for key in ("instance", "job", "service")
            if item.labels.get(key)
        ]
        if details:
            line += " [" + ", ".join(details) + "]"
        lines.append(line)
        description = item.annotations.get("description", "")
        if description:
            lines.append(f"  {description}")
    return "\n".join(lines)


def digest_text(moment: datetime | None = None) -> str:
    """Сводка за сутки: трафик, ошибки, скорость, ресурсы, диск, база, простои."""
    now = moment or datetime.now(_timezone())
    requests = _single(QUERY_REQUESTS)
    errors = _single(QUERY_ERRORS)
    if requests is None or errors is None:
        error_line = "• Запросов за сутки: нет данных"
    else:
        share = errors / requests if requests else 0.0
        error_line = (
            f"• Запросов за сутки: {_count(requests)}, "
            f"из них 5xx: {_count(errors)} ({share * 100:.1f} %)"
        )

    down = [
        item.get("metric", {}).get("job") or item.get("metric", {}).get("instance") or "?"
        for item in query(QUERY_DOWN)
    ]
    stopped = [item.get("metric", {}).get("service") or "?" for item in query(QUERY_STOPPED)]
    offline = sorted(set(down) | set(stopped))

    return "\n".join(
        [
            f"📊 Сводка CRM Dormitory за сутки ({now:%d.%m.%Y %H:%M}, {DIGEST_TIMEZONE})",
            error_line,
            f"• Время ответа p95: {_milliseconds(_single(QUERY_P95))}",
            f"• CPU контейнеров (среднее): {_top(QUERY_CPU, '%', 1.0, 1)}",
            f"• Память контейнеров (среднее): {_top(QUERY_MEMORY, 'МиБ', 1.0 / 1024**2, 0)}",
            f"• Свободно на /: {_percent(_single(QUERY_DISK_FREE))}",
            f"• Размер базы: {_mebibytes(_single(QUERY_DB_SIZE))}",
            f"• Не в строю: {', '.join(offline) if offline else 'никого'}",
        ]
    )


def send(text: str, kind: str) -> bool:
    """Отправить сообщение в Telegram. Не настроен токен — только лог.

    ``kind`` попадает в лог как есть: для алертов это ``АЛЕРТ``, поэтому строка
    в логе находится поиском по слову. Токен в лог не попадает.
    """
    if not BOT_TOKEN or not CHAT_ID:
        logger.info("%s (Telegram не настроен — сообщение только в лог):\n%s", kind, text)
        return False
    data = urllib.parse.urlencode(
        {
            "chat_id": CHAT_ID,
            "text": text,
            "disable_web_page_preview": "true",
        }
    ).encode("utf-8")
    url = f"{TELEGRAM_API_BASE_URL.rstrip('/')}/bot{BOT_TOKEN}/sendMessage"
    try:
        _request(url, data=data, opener=telegram_opener())
    except Exception as error:  # связь с Telegram не должна ронять процесс
        logger.warning("Telegram не принял сообщение (%s): %s", kind, type(error).__name__)
        return False
    logger.info("%s отправлен в Telegram", kind)
    return True


def _digest_loop() -> None:
    """Фон: раз в сутки в DIGEST_HOUR отправить сводку. Ошибка не убивает поток."""
    last_sent: date | None = None
    while True:
        try:
            moment = datetime.now(_timezone())
            if moment.hour == DIGEST_HOUR and last_sent != moment.date():
                last_sent = moment.date()
                send(digest_text(moment), "СВОДКА")
        except Exception:  # поток обязан пережить любой сбой сводки
            logger.exception("Сводка не собрана")
        time.sleep(DIGEST_CHECK_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Поднять поток сводки на время жизни процесса."""
    logger.info(
        "Notifier запущен: сводка в %02d:00 (%s), Telegram %s",
        DIGEST_HOUR,
        DIGEST_TIMEZONE,
        "настроен" if BOT_TOKEN and CHAT_ID else "не настроен — только лог",
    )
    threading.Thread(target=_digest_loop, name="digest", daemon=True).start()
    yield


app = FastAPI(
    title="CRM Dormitory — notifier",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.post("/alert")
def alert(webhook: Webhook) -> dict[str, bool]:
    """Webhook Alertmanager. Отвечает 200 всегда: иначе Alertmanager повторяет."""
    send(alert_text(webhook), "АЛЕРТ")
    return {"ok": True}


@app.post("/digest")
def digest() -> dict[str, bool]:
    """Собрать и отправить сводку сейчас (ручная проверка, не только по часам)."""
    return {"ok": True, "sent": send(digest_text(), "СВОДКА")}


@app.get("/health")
def health() -> dict[str, str]:
    """Живость процесса: по этой ручке compose проверяет notifier."""
    return {"status": "ok"}
