"""Telegram Bot API: единственное место, где приложение говорит с Telegram.

Модуль устроен так же, как `app/dadata.py` для DaData: изолированный внешний
вызов, который не знает ни про SQLAlchemy, ни про FastAPI и целиком подменяется
в тестах. HTTP-клиент передаётся параметром (`client=`), поэтому тест
подставляет `httpx.MockTransport` и сети не касается.

Сбои связи наружу не поднимаются: `False` у `send_message` и пустой список у
`get_updates`. В лог идёт только имя типа ошибки и код ответа Telegram — **без
токена и без `chat_id`**. Это не перестраховка: адрес запроса Bot API содержит
токен бота, и `str(error)` от httpx его бы напечатал.

Разметку не используем: `parse_mode` не ставится вовсе, чтобы символы `*`, `_`,
`<` из ФИО или названия общежития не ломали сообщение.
"""

import logging

import httpx

from app.config import Settings, get_settings
from app.models.telegram import NotificationDelivery

logger = logging.getLogger(__name__)


def render_message(delivery: NotificationDelivery) -> str:
    """Текст сообщения из доставки. Чистая функция, без сети.

    Тема и текст склеиваются в одно сообщение: так человек видит и то, что
    случилось, и подробности, а отдельных «заголовков» в Telegram нет.
    """
    body = (delivery.body or "").strip()
    title = (delivery.title or "").strip()
    if not title:
        return body
    if not body:
        return title
    return f"{title}\n\n{body}"


def _method_url(settings: Settings, method: str) -> str:
    """Адрес метода Bot API вместе с токеном. В логи не попадает."""
    base = settings.telegram_api_base_url.rstrip("/")
    return f"{base}/bot{settings.telegram_bot_token}/{method}"


def _bot_token(settings: Settings) -> str:
    """Токен бота или пустая строка: пустой токен — это не исключение."""
    return settings.telegram_bot_token.strip()


def _post(
    method: str,
    payload: dict[str, object],
    *,
    client: httpx.Client | None = None,
    settings: Settings | None = None,
) -> object | None:
    """Один вызов Bot API. `None` — вызов не удался, подробности в логе.

    Наружу не поднимается ничего: недоступный Telegram не должен ронять ни
    ручку кабинета, ни цикл бота. В логе остаётся только имя типа ошибки или код
    ответа — ни токена, ни `chat_id`, ни текста сообщения.
    """
    resolved = settings or get_settings()
    if not _bot_token(resolved):
        logger.warning("Telegram не настроен: токен бота пуст, вызов %s пропущен", method)
        return None

    owned_client = client is None
    http = (
        client
        if client is not None
        else httpx.Client(timeout=resolved.telegram_request_timeout_seconds)
    )
    try:
        try:
            response = http.post(_method_url(resolved, method), json=payload)
        except httpx.HTTPError as error:
            # Только тип: текст ошибки httpx содержит адрес запроса, а с ним токен.
            logger.error("Telegram недоступен (%s): %s", method, type(error).__name__)
            return None
    finally:
        if owned_client:
            http.close()

    if response.status_code >= httpx.codes.BAD_REQUEST:
        logger.error("Telegram ответил %s на %s", response.status_code, method)
        return None

    try:
        body = response.json()
    except ValueError:
        logger.error("Ответ Telegram не разбирается как JSON (%s)", method)
        return None

    if not isinstance(body, dict) or body.get("ok") is not True:
        # Описание ошибки от Telegram может содержать текст сообщения, поэтому в
        # лог идёт только код: этого хватает, чтобы понять причину отказа.
        error_code = body.get("error_code") if isinstance(body, dict) else None
        logger.error("Telegram отказал (%s): код %s", method, error_code)
        return None
    return body.get("result")


def get_updates(
    *,
    offset: int | None = None,
    client: httpx.Client | None = None,
    settings: Settings | None = None,
) -> list[dict[str, object]]:
    """Забрать новые обновления у Bot API. Пустой список — «ничего нового».

    Публичного вебхука у проекта нет: бот сам ходит за обновлениями. Любая
    проблема связи — это пустой список и запись в лог, а не исключение.
    """
    payload: dict[str, object] = {"timeout": 0}
    if offset is not None:
        payload["offset"] = offset
    result = _post("getUpdates", payload, client=client, settings=settings)
    if not isinstance(result, list):
        return []
    return [item for item in result if isinstance(item, dict)]


def send_message(
    *,
    chat_id: str,
    text: str,
    client: httpx.Client | None = None,
    settings: Settings | None = None,
) -> bool:
    """Отправить сообщение в чат. `False` — сообщение не ушло.

    `chat_id` и текст в лог не попадают: это персональные данные получателя.
    """
    result = _post(
        "sendMessage",
        {"chat_id": chat_id, "text": text},
        client=client,
        settings=settings,
    )
    return result is not None
