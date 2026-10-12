"""Пробный период личного кабинета: один источник правды.

Кабинет начинает работать активацией, и первый месяц работает без тарифа.
Месяц задаётся настройкой `trial_days` и не продлевается правкой данных:
продление — это выбор тарифа, то есть `organizations.tariff_id`.

Правило ровно одно, и оно живёт здесь: **кабинет закрыт, когда тарифа нет и
пробный период не идёт**. Отсюда два производных признака:

* `locked` — кабинет закрыт: рабочие разделы отвечают 403 (`SubscribedUser`),
  открытыми остаются обзор, тариф, организация и личные данные;
* `is_active` — доступ определяется именно пробным периодом (тарифа нет, а
  месяц ещё идёт): только в этом состоянии действует лимит сотрудников.

Пустое `trial_ends_at` — это «пробного периода нет», а не «период ещё не
начался»: так аккаунты, созданные мимо активации, не получают доступа, которого
им не давали. Наивные даты из SQLite считаются UTC — иначе сравнение падает.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from math import ceil

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.organization import Organization
from app.models.user import User

# Сколько сотрудников, кроме владельца, допускает пробный период.
TRIAL_MEMBER_LIMIT = 3

# Тексты отказа: первый — общий для закрытого кабинета, второй — про лимит.
TRIAL_EXPIRED_DETAIL = "Пробный период закончился. Выберите тариф, чтобы продолжить работу"
TRIAL_MEMBER_LIMIT_DETAIL = "На пробном периоде в организации не может быть больше 3 сотрудников"

# Заголовок отказа по лимиту: по нему фронт отличает этот 409 от конфликта по email.
TRIAL_LIMIT_HEADER = "X-Trial-Limit"
TRIAL_LIMIT_HEADER_VALUE = "members"

SECONDS_PER_DAY = 24 * 60 * 60


def _as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: считаем его UTC, иначе сравнение падает."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


@dataclass(frozen=True)
class TrialState:
    """Состояние пробного периода для текущего пользователя."""

    started_at: datetime | None
    ends_at: datetime | None
    days_left: int
    is_active: bool
    locked: bool
    member_limit: int


def trial_ends_at_for(now: datetime | None = None) -> datetime:
    """Конец пробного периода для кабинета, активированного в этот момент."""
    return _as_utc(now or datetime.now(UTC)) + timedelta(days=get_settings().trial_days)


def organization_has_tariff(db: Session, user: User) -> bool:
    """Выбран ли тариф у организации пользователя.

    Смотрим на `tariff_id` активной организации: нет организации — нет и тарифа,
    а `NULL` в колонке означает «тариф ещё не выбран».
    """
    if user.active_organization_id is None:
        return False
    return (
        db.scalar(
            select(Organization.tariff_id).where(Organization.id == user.active_organization_id)
        )
        is not None
    )


def trial_state(db: Session, user: User, now: datetime | None = None) -> TrialState:
    """Состояние пробного периода: работает ли кабинет и сколько дней осталось."""
    moment = _as_utc(now or datetime.now(UTC))
    ends_at = _as_utc(user.trial_ends_at) if user.trial_ends_at is not None else None

    # Период «идёт», только когда у него есть конец и он в будущем.
    running = ends_at is not None and ends_at > moment
    has_tariff = organization_has_tariff(db, user)

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
        member_limit=TRIAL_MEMBER_LIMIT,
    )
