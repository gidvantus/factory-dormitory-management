"""Пробный период личного кабинета: один источник правды.

Кабинет начинает работать активацией, и первый срок (по умолчанию две недели)
работает без тарифа. Срок задаётся настройкой `trial_days` и не продлевается
правкой данных: продление — это покупка тарифа, то есть подписка организации
(`app/subscription.py`).

Правило ровно одно, и оно живёт здесь: **кабинет закрыт, когда действующего
тарифа нет и пробный период не идёт**. Отсюда два производных признака:

* `locked` — кабинет закрыт: рабочие разделы отвечают 403 (`SubscribedUser`),
  открытыми остаются обзор, тариф, организация и личные данные;
* `is_active` — доступ определяется именно пробным периодом (тарифа нет, а
  срок ещё идёт): только в этом состоянии пробный предел сотрудников, если он
  задан, ограничивает приглашения.

Истёкший тариф больше не держит кабинет открытым: срок считается в
`app/subscription.py`, и если оплаченного вперёд периода нет — это закрытый
кабинет, тот же, что был после пробного срока. Если будущий период оплачен,
действует он, и кабинет открыт — без фонового воркера.

Пустое `trial_ends_at` — это «пробного периода нет», а не «период ещё не
начался»: так аккаунты, созданные мимо активации, не получают доступа, которого
им не давали. Наивные даты из SQLite считаются UTC — иначе сравнение падает.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from math import ceil

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.user import User
from app.subscription import subscription_state

# Текст отказа закрытого кабинета. Отказ по местам собирает
# `app/subscription.py`: он один и тот же у пробного периода и у тарифа.
TRIAL_EXPIRED_DETAIL = "Пробный период закончился. Выберите тариф, чтобы продолжить работу"

SECONDS_PER_DAY = 24 * 60 * 60


def _as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: считаем его UTC, иначе сравнение падает."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


@dataclass(frozen=True)
class TrialState:
    """Состояние пробного периода для текущего пользователя.

    `member_limit` — сколько сотрудников, кроме владельца, допускает пробный
    период по настройке `trial_member_limit`. `None` — предела нет: так
    приложение работает по умолчанию.
    """

    started_at: datetime | None
    ends_at: datetime | None
    days_left: int
    is_active: bool
    locked: bool
    member_limit: int | None


def trial_ends_at_for(now: datetime | None = None) -> datetime:
    """Конец пробного периода для кабинета, активированного в этот момент."""
    return _as_utc(now or datetime.now(UTC)) + timedelta(days=get_settings().trial_days)


def organization_has_tariff(db: Session, user: User, now: datetime | None = None) -> bool:
    """Есть ли у организации пользователя действующий тариф.

    Смотрим на подписку, а не на одну ссылку `tariff_id`: истёкший период тарифом
    больше не считается, а оплаченный вперёд — считается, даже если текущий слот
    уже кончился. Нет организации — нет и тарифа.
    """
    if user.active_organization_id is None:
        return False
    return subscription_state(db, user.active_organization_id, now).is_active


def trial_state(db: Session, user: User, now: datetime | None = None) -> TrialState:
    """Состояние пробного периода: работает ли кабинет и сколько дней осталось."""
    moment = _as_utc(now or datetime.now(UTC))
    ends_at = _as_utc(user.trial_ends_at) if user.trial_ends_at is not None else None

    # Период «идёт», только когда у него есть конец и он в будущем.
    running = ends_at is not None and ends_at > moment
    has_tariff = organization_has_tariff(db, user, moment)

    days_left = 0
    started_at: datetime | None = None
    if running and ends_at is not None:
        started_at = ends_at - timedelta(days=get_settings().trial_days)
        # Целые сутки вверх: неполный последний день считается за полный.
        days_left = max(0, ceil((ends_at - moment).total_seconds() / SECONDS_PER_DAY))

    return TrialState(
        started_at=started_at,
        ends_at=ends_at,
        days_left=days_left,
        # С тарифом пробный режим доступа больше не определяет — и лимита нет.
        is_active=running and not has_tariff,
        locked=not has_tariff and not running,
        # Предел мест пробного периода — настройка, а не константа: незаданное
        # значение означает «предела нет».
        member_limit=get_settings().trial_member_limit,
    )
