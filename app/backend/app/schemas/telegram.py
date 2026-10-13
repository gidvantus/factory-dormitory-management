"""Схемы запросов и ответов Telegram-уведомлений.

Контракт один на две аудитории: бот (сервисный токен) и кабинет (cookie). Роуты
бота и кабинета живут в одном файле `app/api/telegram.py`, поэтому и схемы
рядом — так по одному файлу видно, что именно уходит наружу.
"""

from pydantic import BaseModel, Field, field_validator

from app.models.telegram import NOTIFICATION_KINDS

# Тексты отказа кабинета. Технических подробностей в них нет намеренно.
TELEGRAM_NOT_CONFIGURED_DETAIL = "Telegram не настроен"
TELEGRAM_NOT_CONNECTED_DETAIL = "Telegram не подключён"
UNKNOWN_NOTIFICATION_KIND_DETAIL = "Неизвестный вид уведомления"

# Причина 410 у бота: код неизвестен, просрочен или уже погашен.
INVALID_LINK_CODE_REASON = "invalid_code"


class ChatLinkRequest(BaseModel):
    """`POST /api/telegram/chat` — привязка чата по коду из кабинета."""

    code: str = Field(min_length=1, max_length=512)
    chat_id: str = Field(min_length=1, max_length=32)
    username: str | None = Field(default=None, max_length=64)


class ChatLinkResponse(BaseModel):
    """Ответ привязки. 200 — `linked: true`, 410 — `linked: false` с причиной."""

    linked: bool
    full_name: str | None = None
    reason: str | None = None


class FeedItemResponse(BaseModel):
    """Одно готовое сообщение для бота."""

    id: int
    text: str


class FeedResponse(BaseModel):
    """Лента чата. Пустая лента — это 200 с пустым `items`."""

    items: list[FeedItemResponse]


class DeliveryFailedRequest(BaseModel):
    """`POST /api/telegram/feed/{id}/failed` — Bot API отказал.

    Длина здесь не ограничена: текст обрезается до длины колонки в
    `app/notifications.py`, чтобы длинное значение не превращалось в 422 вместо
    отметки `failed`.
    """

    error: str = Field(default="")


class SubscriptionResponse(BaseModel):
    """Вид события и состояние подписки на него."""

    kind: str
    title: str
    is_enabled: bool


class TelegramStatusResponse(BaseModel):
    """Состояние подключения и подписки для карточки кабинета."""

    connected: bool
    username: str | None
    bot_username: str
    subscriptions: list[SubscriptionResponse]


class TelegramConnectResponse(BaseModel):
    """Код привязки и ссылка на бота: имя бота фронт не знает, его даёт сервер."""

    code: str
    deep_link: str
    expires_at: str


class TelegramDisconnectResponse(BaseModel):
    connected: bool


class UpdateSubscriptionRequest(BaseModel):
    """Правка подписки. Незнакомый вид события — это 422."""

    kind: str
    is_enabled: bool

    @field_validator("kind")
    @classmethod
    def check_kind(cls, value: str) -> str:
        if value not in NOTIFICATION_KINDS:
            raise ValueError(UNKNOWN_NOTIFICATION_KIND_DETAIL)
        return value


class TestMessageResponse(BaseModel):
    """Тестовое сообщение поставлено в очередь."""

    queued: bool
