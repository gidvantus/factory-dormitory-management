"""Telegram: ручки бота и ручки кабинета в одном месте.

Две аудитории — две авторизации:

* роуты бота (`/chat`, `/feed`, `/feed/{id}/failed`) закрыты сервисным токеном в
  заголовке `X-Bot-Token`: бот не человек, cookie сессии у него нет;
* роуты кабинета (`/status`, `/connect`, `/disconnect`, `/subscriptions`,
  `/test-message`) закрыты обычной cookie (`ActiveUser`).

Публичного вебхука нет: наружу не открывается ни один роут без сервисного
токена, `setWebhook` не вызывается вовсе. Бот сам забирает готовые доставки.

Предметная логика живёт в `app/notifications.py`, разговор с Bot API — в
`app/telegram.py`. Здесь только HTTP: коды ответов и преобразование строк
очереди в текст сообщения.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notifications
from app.config import get_settings
from app.db import get_db
from app.models.telegram import NotificationDelivery, kind_title
from app.models.user import User
from app.schemas.telegram import (
    INVALID_LINK_CODE_REASON,
    TELEGRAM_NOT_CONFIGURED_DETAIL,
    TELEGRAM_NOT_CONNECTED_DETAIL,
    BadRequestResponse,
    ChatLinkRequest,
    ChatLinkResponse,
    ChatsResponse,
    DeliveryFailedRequest,
    FeedItemResponse,
    FeedResponse,
    SubscriptionResponse,
    TelegramConnectResponse,
    TelegramDisconnectResponse,
    TelegramStatusResponse,
    TestMessageResponse,
    UpdateSubscriptionRequest,
)
from app.schemas.user import ErrorResponse
from app.security import ACTIVE_USER_RESPONSES, ActiveUser, ServiceBot
from app.telegram import render_message

router = APIRouter(
    prefix="/telegram",
    tags=["telegram"],
    responses={
        401: {"model": ErrorResponse, "description": "Требуется сервисный токен или cookie сессии"},
    },
)

DbSession = Annotated[Session, Depends(get_db)]
ChatId = Annotated[str, Query(min_length=1, max_length=32)]
FeedLimit = Annotated[int, Query(ge=1, le=100)]

# Один и тот же 410 у бота: «код не подошёл». Причины не различаются, иначе по
# ответу можно было бы узнать, существует ли код.
INVALID_CODE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_410_GONE: {
        "model": ChatLinkResponse,
        "description": "Код неизвестен, просрочен или уже погашен",
    },
}

NOT_CONFIGURED_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_503_SERVICE_UNAVAILABLE: {
        "model": ErrorResponse,
        "description": TELEGRAM_NOT_CONFIGURED_DETAIL,
    },
}

NOT_CONNECTED_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": TELEGRAM_NOT_CONNECTED_DETAIL,
    },
}

# Тело запроса, которое не разбирается как JSON, отвергает сам Starlette — до
# валидации схемы, поэтому ответ 400, а не 422. Он объявлен у ручек с телом:
# иначе схемы обещают только 422, а живой сервис отвечает и 400.
BAD_REQUEST_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_400_BAD_REQUEST: {
        "model": BadRequestResponse,
        "description": "Тело запроса не разбирается как JSON",
    },
}


def _subscription_list(db: Session, user: User) -> list[SubscriptionResponse]:
    """Список подписок каталога в том виде, в каком его отдаёт кабинет."""
    return [
        SubscriptionResponse(kind=kind, title=kind_title(kind), is_enabled=is_enabled)
        for kind, is_enabled in notifications.subscriptions(db, user)
    ]


@router.post(
    "/chat",
    response_model=ChatLinkResponse,
    response_model_exclude_none=True,
    summary="Привязать чат бота к кабинету по коду",
    responses={**INVALID_CODE_RESPONSES, **BAD_REQUEST_RESPONSES},
)
def link_chat(
    payload: ChatLinkRequest,
    response: Response,
    _bot: ServiceBot,
    db: DbSession,
) -> ChatLinkResponse:
    """Погасить код из кабинета и связать чат с учётной записью.

    410 — код неизвестен, просрочен или уже погашен. Одна причина на все три
    случая: различать их наружу незачем, а понять по ответу, «жив ли код», не
    должно быть можно.
    """
    user = notifications.link_chat(
        db, code=payload.code, chat_id=payload.chat_id, username=payload.username
    )
    if user is None:
        response.status_code = status.HTTP_410_GONE
        return ChatLinkResponse(linked=False, reason=INVALID_LINK_CODE_REASON)
    db.commit()
    return ChatLinkResponse(linked=True, full_name=user.full_name)


@router.get("/feed", response_model=FeedResponse, summary="Забрать готовые уведомления чата")
def read_feed(
    _bot: ServiceBot,
    db: DbSession,
    chat_id: ChatId,
    limit: FeedLimit = 20,
) -> FeedResponse:
    """Отдать готовые доставки и пометить их отправленными в той же транзакции.

    Пометка и выдача идут вместе: иначе обрыв между ними отправил бы то же
    сообщение второй раз. Пустая лента — это 200 с пустым `items`.
    """
    deliveries = notifications.pending_for_chat(db, chat_id, limit)
    items = [FeedItemResponse(id=row.id, text=render_message(row)) for row in deliveries]
    notifications.mark_sent(db, [row.id for row in deliveries])
    db.commit()
    return FeedResponse(items=items)


@router.get(
    "/chats",
    response_model=ChatsResponse,
    summary="Чаты с живой привязкой",
)
def list_chats(_bot: ServiceBot, db: DbSession) -> ChatsResponse:
    """Кому бот может доставить сообщение прямо сейчас.

    Готовое уведомление адресовано человеку, а не ответу на его сообщение:
    без этого списка бот обходил бы только те чаты, откуда пришло обновление, и
    доставка ждала бы, пока получатель сам напишет боту.
    """
    return ChatsResponse(items=notifications.connected_chats(db))


@router.post(
    "/feed/{delivery_id}/failed",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Отметить доставку неудачной",
    responses={
        status.HTTP_404_NOT_FOUND: {"model": ErrorResponse, "description": "Доставка не найдена"},
        **BAD_REQUEST_RESPONSES,
    },
)
def mark_delivery_failed(
    delivery_id: int,
    payload: DeliveryFailedRequest,
    _bot: ServiceBot,
    db: DbSession,
) -> None:
    """Bot API отказал: доставка помечается `failed` и больше не выдаётся."""
    exists = db.scalar(
        select(NotificationDelivery.id).where(NotificationDelivery.id == delivery_id)
    )
    if exists is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Доставка не найдена")
    notifications.mark_failed(db, delivery_id, payload.error)


@router.get(
    "/status",
    response_model=TelegramStatusResponse,
    summary="Состояние подключения Telegram",
    responses={**ACTIVE_USER_RESPONSES},
)
def read_status(user: ActiveUser, db: DbSession) -> TelegramStatusResponse:
    """Подключение, имя бота и подписки — всё, что нужно карточке кабинета."""
    connected, username = notifications.link_status(db, user)
    return TelegramStatusResponse(
        connected=connected,
        username=username,
        bot_username=get_settings().telegram_bot_username,
        subscriptions=_subscription_list(db, user),
    )


@router.post(
    "/connect",
    response_model=TelegramConnectResponse,
    summary="Выдать код привязки Telegram",
    responses={**ACTIVE_USER_RESPONSES, **NOT_CONFIGURED_RESPONSES},
)
def connect(user: ActiveUser, db: DbSession) -> TelegramConnectResponse:
    """Выдать одноразовый код и ссылку на бота.

    Ссылку собирает сервер: фронт имени бота не знает. Пока бот не настроен
    (пустой токен или имя), ручка отвечает 503 — подключать некуда.
    """
    settings = get_settings()
    bot_username = settings.telegram_bot_username.strip()
    if not settings.telegram_bot_token.strip() or not bot_username:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, TELEGRAM_NOT_CONFIGURED_DETAIL)

    code, expires_at = notifications.issue_link_code(db, user)
    db.commit()
    return TelegramConnectResponse(
        code=code,
        deep_link=f"https://t.me/{bot_username}?start={code}",
        expires_at=expires_at.isoformat(),
    )


@router.post(
    "/disconnect",
    response_model=TelegramDisconnectResponse,
    summary="Отвязать Telegram",
    responses={**ACTIVE_USER_RESPONSES},
)
def disconnect(user: ActiveUser, db: DbSession) -> TelegramDisconnectResponse:
    """Отвязка помечает привязку `revoked_at`: сообщения человеку больше не уходят."""
    notifications.unlink(db, user)
    db.commit()
    return TelegramDisconnectResponse(connected=False)


@router.patch(
    "/subscriptions",
    response_model=list[SubscriptionResponse],
    summary="Включить или выключить вид уведомлений",
    responses={**ACTIVE_USER_RESPONSES, **BAD_REQUEST_RESPONSES},
)
def update_subscription(
    payload: UpdateSubscriptionRequest,
    user: ActiveUser,
    db: DbSession,
) -> list[SubscriptionResponse]:
    """Вернуть обновлённый список подписок: кабинету не нужен второй запрос."""
    notifications.set_subscription(db, user, kind=payload.kind, is_enabled=payload.is_enabled)
    db.commit()
    return _subscription_list(db, user)


@router.post(
    "/test-message",
    response_model=TestMessageResponse,
    summary="Прислать тестовое уведомление",
    responses={**ACTIVE_USER_RESPONSES, **NOT_CONNECTED_RESPONSES},
)
def send_test_message(user: ActiveUser, db: DbSession) -> TestMessageResponse:
    """Проверить всю цепочку, никого не выселяя: очередь → бот → Telegram."""
    if not notifications.queue_test_message(db, user):
        raise HTTPException(status.HTTP_409_CONFLICT, TELEGRAM_NOT_CONNECTED_DETAIL)
    db.commit()
    return TestMessageResponse(queued=True)
