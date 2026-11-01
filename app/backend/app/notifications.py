"""Уведомления: привязка Telegram и очередь доставки.

Здесь вся предметная логика уведомлений, без FastAPI и без HTTP — по образцу
`app/mail.py`. Наружу модуль отдаёт готовые к отправке строки `notification_
deliveries`; как именно они уедут в Telegram, решает `app/telegram.py` и бот.

Разделение намеренное: очередь и персональные правила — это состояние CRM, и
проверять их можно без сети. Состояние бота (offset, сбой отправки) в базу не
пишется, кроме `status` уже созданной доставки.
"""

import logging
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from uuid import uuid4

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.activation import ActivationToken
from app.models.telegram import (
    DELIVERY_FAILED,
    DELIVERY_PENDING,
    DELIVERY_SENT,
    TELEGRAM_TEST_KIND,
    NotificationDelivery,
    TelegramLink,
    kind_title,
)
from app.models.user import User
from app.security import hash_activation_token

logger = logging.getLogger(__name__)

# Вид одноразовой ссылки, которой бот доказывает привязку чата к кабинету.
TELEGRAM_LINK_TOKEN_KIND = "telegram_link"

# Длина открытого кода: 32 байта энтропии, как у ссылки активации.
LINK_CODE_BYTES = 32

# Сколько доставок отдаётся боту за один заход по умолчанию.
DEFAULT_FEED_LIMIT = 20

# Потолок длины текста ошибки: колонка `error` — `varchar(255)`.
MAX_ERROR_LENGTH = 255


def _as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: считаем его UTC, иначе сравнение падает."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def issue_link_code(db: Session, user: User) -> tuple[str, datetime]:
    """Выпустить код привязки чата. Открытый код возвращается, в базу идёт хеш.

    Код одноразовый и живёт `telegram_link_ttl_minutes`. Коммитит вызывающий:
    ручка кабинета отдаёт код человеку только вместе с сохранённой строкой.
    """
    settings = get_settings()
    code = token_urlsafe(LINK_CODE_BYTES)
    expires_at = datetime.now(UTC) + timedelta(minutes=settings.telegram_link_ttl_minutes)
    db.add(
        ActivationToken(
            user_id=user.id,
            kind=TELEGRAM_LINK_TOKEN_KIND,
            token_hash=hash_activation_token(code),
            expires_at=expires_at,
        )
    )
    db.flush()
    return code, expires_at


def link_chat(db: Session, *, code: str, chat_id: str, username: str | None) -> User | None:
    """Погасить код и связать чат с учётной записью.

    `None` — если код неизвестен, просрочен или уже погашен: ручка бота отвечает
    на это 410, не различая причины. Повторная привязка того же пользователя не
    заводит вторую строку: прежняя оживает и получает новый `chat_id`.
    """
    record = db.scalar(
        select(ActivationToken).where(
            ActivationToken.kind == TELEGRAM_LINK_TOKEN_KIND,
            ActivationToken.token_hash == hash_activation_token(code),
        )
    )
    if record is None or record.used_at is not None:
        return None
    if _as_utc(record.expires_at) <= datetime.now(UTC):
        return None

    user = db.get(User, record.user_id)
    if user is None:
        return None

    record.used_at = datetime.now(UTC)
    link = db.scalar(select(TelegramLink).where(TelegramLink.user_id == user.id))
    if link is None:
        db.add(TelegramLink(user_id=user.id, chat_id=chat_id, username=username))
    else:
        link.chat_id = chat_id
        link.username = username
        link.revoked_at = None
    db.flush()
    return user


def unlink(db: Session, user: User) -> None:
    """Отвязать чат: строка помечается `revoked_at`, а не удаляется.

    Коммитит вызывающий. История доставок остаётся целой: сообщения по уже
    созданным событиям должны быть видны, даже если человек отключил Telegram.
    """
    link = db.scalar(select(TelegramLink).where(TelegramLink.user_id == user.id))
    if link is None or link.revoked_at is not None:
        return
    link.revoked_at = datetime.now(UTC)
    db.flush()


def link_status(db: Session, user: User) -> tuple[bool, str | None]:
    """Подключён ли Telegram и какой у привязки `username`."""
    link = db.scalar(
        select(TelegramLink).where(
            TelegramLink.user_id == user.id,
            TelegramLink.revoked_at.is_(None),
        )
    )
    if link is None:
        return False, None
    return True, link.username


def queue_test_message(db: Session, user: User) -> bool:
    """Поставить текущему пользователю тестовое сообщение.

    Это способ проверить всю цепочку «кабинет → очередь → бот → Telegram» без
    настоящего события. Ключ с `uuid4` взят из задачи: он не уникален по смыслу,
    но и повтор тестового сообщения не должен упираться в `UNIQUE (user_id,
    event_key)`. Коммитит вызывающий.

    `False` — чат не подключён: доставлять некуда.
    """
    link = db.scalar(
        select(TelegramLink).where(
            TelegramLink.user_id == user.id,
            TelegramLink.revoked_at.is_(None),
        )
    )
    if link is None:
        return False

    event_key = f"{TELEGRAM_TEST_KIND}:{uuid4()}"
    db.add(
        NotificationDelivery(
            user_id=user.id,
            chat_id=link.chat_id,
            kind=TELEGRAM_TEST_KIND,
            event_key=event_key,
            title=kind_title(TELEGRAM_TEST_KIND),
            body="Проверка связи: уведомления из кабинета приходят в этот чат.",
            status=DELIVERY_PENDING,
        )
    )
    return True


def pending_for_chat(
    db: Session, chat_id: str, limit: int = DEFAULT_FEED_LIMIT
) -> list[NotificationDelivery]:
    """Готовые к отправке доставки одного чата, самые старые первыми."""
    return list(
        db.scalars(
            select(NotificationDelivery)
            .where(
                NotificationDelivery.chat_id == chat_id,
                NotificationDelivery.status == DELIVERY_PENDING,
            )
            .order_by(NotificationDelivery.id)
            .limit(limit)
        )
    )


def connected_chats(db: Session) -> list[str]:
    """Чаты всех живых привязок.

    Нужны боту: готовое уведомление адресовано человеку, а не ответу на его
    сообщение, и ждать, пока получатель сам что-нибудь напишет, нельзя — иначе
    доставка висит в `pending` сколько угодно. Бот забирает этот список и
    обходит ленту каждого чата.

    Сортировка именно по `chat_id`, а не по `id`: с `SELECT DISTINCT` Postgres
    требует, чтобы выражение из `ORDER BY` было в списке выборки, а `id` туда не
    попадает — запрос падал бы на живой базе, хотя на SQLite проходит.
    """
    return list(
        db.scalars(
            select(TelegramLink.chat_id)
            .where(TelegramLink.revoked_at.is_(None))
            .order_by(TelegramLink.chat_id)
            .distinct()
        )
    )


def mark_sent(db: Session, ids: list[int]) -> None:
    """Пометить доставки отправленными. Коммитит вызывающий.

    Пометка идёт в одной транзакции с выдачей `feed`: иначе при обрыве между
    выдачей и пометкой то же сообщение ушло бы второй раз.
    """
    if not ids:
        return
    db.execute(
        update(NotificationDelivery)
        .where(NotificationDelivery.id.in_(ids))
        .values(status=DELIVERY_SENT, sent_at=func.now())
    )


def mark_failed(db: Session, delivery_id: int, error: str) -> None:
    """Пометить доставку неудачной, обрезав текст ошибки до длины колонки."""
    db.execute(
        update(NotificationDelivery)
        .where(NotificationDelivery.id == delivery_id)
        .values(status=DELIVERY_FAILED, error=error[:MAX_ERROR_LENGTH])
    )
    db.commit()
