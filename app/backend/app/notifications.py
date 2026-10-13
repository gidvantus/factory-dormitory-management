"""Уведомления: привязка Telegram, подписки и очередь доставки.

Здесь вся предметная логика уведомлений, без FastAPI и без HTTP — по образцу
`app/mail.py`. Наружу модуль отдаёт готовые к отправке строки `notification_
deliveries`; как именно они уедут в Telegram, решает `app/telegram.py` и бот.

Разделение намеренное: очередь и правила получателей — это состояние CRM, и
проверять их можно без сети. Состояние бота (offset, сбой отправки) в базу не
пишется, кроме `status` уже созданной доставки.
"""

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from secrets import token_urlsafe
from uuid import uuid4

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.activation import ActivationToken
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel
from app.models.organization import OrganizationMember
from app.models.resident import Resident
from app.models.telegram import (
    DELIVERY_FAILED,
    DELIVERY_PENDING,
    DELIVERY_SENT,
    NOTIFICATION_KINDS,
    RESIDENT_OUTFLOW_KIND,
    TELEGRAM_TEST_KIND,
    NotificationDelivery,
    NotificationSubscription,
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


@dataclass(frozen=True)
class ResidentOutflowEvent:
    """Снимок проживающего для уведомления о выселении.

    Отдельный тип, потому что сам хук выселения удаляет строку проживающего:
    уведомление ставится в очередь **после** коммита выселения, и к этому
    моменту от ORM-объекта читать уже нечего. Снимок собирается до удаления.
    """

    resident_id: int
    full_name: str | None
    personnel_number: str | None
    dormitory_name: str | None
    hostel_name: str | None
    shift_start: date | None
    shift_end: date | None
    departure_date: date | None


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


def subscriptions(db: Session, user: User) -> list[tuple[str, bool]]:
    """Виды событий каталога и состояние подписки на каждый.

    Строки в `notification_subscriptions` может не быть: это «подписка по
    умолчанию», а по умолчанию человек подписан. Поэтому наружу идёт пара
    «вид — включено», а не список строк из базы.
    """
    disabled = set(
        db.scalars(
            select(NotificationSubscription.kind).where(
                NotificationSubscription.user_id == user.id,
                NotificationSubscription.is_enabled.is_(False),
            )
        )
    )
    return [(kind, kind not in disabled) for kind in NOTIFICATION_KINDS]


def set_subscription(db: Session, user: User, *, kind: str, is_enabled: bool) -> None:
    """Включить или выключить подписку. Коммитит вызывающий.

    Вид события проверяет схема запроса: неизвестный `kind` до этой функции не
    доходит.
    """
    record = db.scalar(
        select(NotificationSubscription).where(
            NotificationSubscription.user_id == user.id,
            NotificationSubscription.kind == kind,
        )
    )
    if record is None:
        db.add(NotificationSubscription(user_id=user.id, kind=kind, is_enabled=is_enabled))
    else:
        record.is_enabled = is_enabled
    db.flush()


def recipients(db: Session, actor_id: int) -> list[tuple[User, TelegramLink]]:
    """Кто получит уведомление о событии, которое сделал `actor_id`.

    Получатели — живые привязки коллег по организации актора: членство ищется в
    `organization_members`, а не по роли, и роль на выбор получателей не влияет.
    Условия: чат не отвязан, кабинет активирован и подписка на вид события не
    выключена. Сам актор уведомление не получает — он это только что сделал сам.
    """
    actor = db.get(User, actor_id)
    if actor is None or actor.active_organization_id is None:
        return []

    unsubscribed = select(NotificationSubscription.user_id).where(
        NotificationSubscription.kind == RESIDENT_OUTFLOW_KIND,
        NotificationSubscription.is_enabled.is_(False),
    )
    rows = db.execute(
        select(User, TelegramLink)
        .join(TelegramLink, TelegramLink.user_id == User.id)
        .join(OrganizationMember, OrganizationMember.user_id == User.id)
        .where(
            TelegramLink.revoked_at.is_(None),
            OrganizationMember.organization_id == actor.active_organization_id,
            User.is_active.is_(True),
            User.id != actor_id,
            User.id.not_in(unsubscribed),
        )
        .order_by(User.id)
    ).all()
    return [(user, link) for user, link in rows]


def capture_resident_outflow(
    db: Session, resident: Resident, *, departure_date: date | None
) -> ResidentOutflowEvent:
    """Снять с проживающего всё, что нужно для текста уведомления.

    Вызывается до удаления строки: сам хук выселения удаляет проживающего тем
    же коммитом, поэтому после него читать ORM-объект уже нельзя.
    """
    dormitory = db.get(Dormitory, resident.dormitory_id) if resident.dormitory_id else None
    hostel = db.get(Hostel, resident.hostel_id) if resident.hostel_id else None
    return ResidentOutflowEvent(
        resident_id=resident.id,
        full_name=resident.full_name,
        personnel_number=resident.personnel_number,
        dormitory_name=dormitory.name if dormitory else None,
        hostel_name=hostel.name if hostel else None,
        shift_start=resident.shift_start,
        shift_end=resident.shift_end,
        departure_date=departure_date,
    )


def render_resident_outflow(event: ResidentOutflowEvent) -> tuple[str, str]:
    """Тема и текст уведомления о выселении. Чистая функция, без сети.

    Разметку Telegram не используем: символы `*`, `_`, `<` из ФИО или названия
    общежития сломали бы сообщение, поэтому текст собирается обычными строками.
    """
    lines = [f"Проживание завершено: {event.full_name or 'без ФИО'}"]
    if event.personnel_number:
        lines.append(f"Табельный номер: {event.personnel_number}")
    if event.dormitory_name:
        lines.append(f"Общежитие: {event.dormitory_name}")
    if event.hostel_name:
        lines.append(f"Хостел: {event.hostel_name}")
    if event.departure_date is not None:
        lines.append(f"Дата выезда: {event.departure_date.isoformat()}")
    elif event.shift_end is not None:
        lines.append(f"Дата выезда: {event.shift_end.isoformat()}")
    return kind_title(RESIDENT_OUTFLOW_KIND), "\n".join(lines)


def queue_resident_outflow(db: Session, *, resident: ResidentOutflowEvent, actor_id: int) -> int:
    """Поставить доставки о выселении проживающего. Возвращает число новых.

    Ключ идемпотентности — `resident_outflow:<id проживающего>`: повторный вызов
    по тому же событию не создаёт вторую доставку, и это же держит
    `UNIQUE (user_id, event_key)` в базе.

    Коммитит сама: уведомление не часть транзакции выселения, и падение рассылки
    не должно откатывать уже подтверждённый отток.
    """
    event_key = f"{RESIDENT_OUTFLOW_KIND}:{resident.resident_id}"
    title, body = render_resident_outflow(resident)
    already_queued = set(
        db.scalars(
            select(NotificationDelivery.user_id).where(NotificationDelivery.event_key == event_key)
        )
    )
    created = 0
    for user, link in recipients(db, actor_id):
        if user.id in already_queued:
            continue
        db.add(
            NotificationDelivery(
                user_id=user.id,
                chat_id=link.chat_id,
                kind=RESIDENT_OUTFLOW_KIND,
                event_key=event_key,
                title=title,
                body=body,
                status=DELIVERY_PENDING,
            )
        )
        created += 1
    db.commit()
    return created


def queue_test_message(db: Session, user: User) -> bool:
    """Поставить текущему пользователю тестовое сообщение.

    Это способ проверить всю цепочку «кабинет → очередь → бот → Telegram», никого
    не выселяя. Ключ с `uuid4` взят из задачи: он не уникален по смыслу, но и
    повтор тестового сообщения не должен упираться в `UNIQUE (user_id,
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
            body="Тестовое уведомление из личного кабинета. Если вы его видите, связь работает.",
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
