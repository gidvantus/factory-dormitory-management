"""Срок действия тарифа организации: один источник правды.

Тариф, как и пробный период, кончается в конкретный момент: `period` строки
прайса превращается в `organizations.tariff_ends_at` в момент оплаты. Граница
**исключающая** — та же, что у `users.trial_ends_at` (`app/trial.py`) и у прав на
решения (`app/solutions.py`): в момент `ends_at` тариф уже не действует, а
продление отсчитывается от `max(сейчас, срок)`.

Слотов подписки два — текущий и будущий (см. `app/models/organization.py`):

* **текущий** — `tariff_id` + `tariff_ends_at`. Пока срок не истёк, организация
  работает на этом тарифе;
* **будущий** — `next_tariff_id` + `next_tariff_ends_at`. Он начинает действовать
  ровно с `tariff_ends_at` текущего: «следующий день после последнего
  оплаченного» — это и есть исключающая граница, отдельного поля начала нет.

На чтении здесь **ничего не мутирует**: в проекте нет ни cron, ни очереди, и
кабинет не может ждать фонового воркера. Истёкший текущий слот и оплаченный
будущий — это вычисление: действующим считается будущий тариф, и кабинет
остаётся открытым. Переезд «наступившего» будущего периода в текущий слот делает
оплата счёта (`record_payment`) — единственная транзакция, которая вообще пишет
подписку, — поэтому после неё слоты снова выглядят просто.

`NULL` в `tariff_ends_at` у заполненного `tariff_id` — бессрочный тариф (так его
назначает администратор платформы и так лежат строки периода `once`). Бессрочный
тариф не имеет конца, поэтому и продлить его нельзя: будущему периоду не от чего
отсчитываться — оба слота считаются занятыми.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from math import ceil

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.organization import Organization
from app.models.tariff import Tariff
from app.solutions import entitlement_expiry

# Заголовок и текст отказа по местам: по нему фронт отличает этот 409 от прочих.
MEMBER_LIMIT_HEADER = "X-Member-Limit"
MEMBER_LIMIT_HEADER_VALUE = "seats"

# Отказ, когда оплачены оба слота: третий тариф до наступления будущего не продаётся.
TARIFF_ALREADY_BOUGHT_DETAIL = "Тариф уже оплачен на будущий период"

# За сколько дней до конца срока кабинет предупреждает о продлении.
EXPIRING_DAYS = 14

# Слоты подписки: куда встанет следующая оплата.
CURRENT_SLOT = "current"
FUTURE_SLOT = "future"

SECONDS_PER_DAY = 24 * 60 * 60


def as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: считаем его UTC, иначе сравнение падает."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


@dataclass(frozen=True)
class Slots:
    """Слоты организации после «виртуального» переезда наступившего периода.

    Значения посчитаны на момент `now`, но организация не изменена: переезд
    запишет `record_payment` (или ничего не запишет, если оплаты не было).
    """

    current_tariff_id: int | None
    current_ends_at: datetime | None
    next_tariff_id: int | None
    next_ends_at: datetime | None


@dataclass(frozen=True)
class SubscriptionState:
    """Действующий тариф и то, что оплачено вперёд.

    `days_left` — целые сутки до конца, округлённые вверх (неполный последний
    день считается за полный), как у пробного периода. У бессрочного тарифа и у
    закрытого кабинета остаётся `0`: считать нечего.
    """

    tariff: Tariff | None
    ends_at: datetime | None
    days_left: int
    is_expiring: bool
    next_tariff: Tariff | None
    next_starts_at: datetime | None

    @property
    def is_active(self) -> bool:
        """Работает ли кабинет по тарифу прямо сейчас."""
        return self.tariff is not None

    @property
    def member_limit(self) -> int | None:
        """Предел мест действующего тарифа. `None` — без ограничения."""
        return self.tariff.max_members if self.tariff is not None else None


EMPTY_STATE = SubscriptionState(
    tariff=None,
    ends_at=None,
    days_left=0,
    is_expiring=False,
    next_tariff=None,
    next_starts_at=None,
)


def organization_slots(organization: Organization, now: datetime | None = None) -> Slots:
    """Слоты подписки: наступивший будущий период считается текущим.

    Функция чистая — она не пишет в базу и не меняет строку организации, поэтому
    ею пользуются и ручки чтения, и проверка покупки.
    """
    moment = as_utc(now or datetime.now(UTC))
    current_ends = (
        as_utc(organization.tariff_ends_at) if organization.tariff_ends_at is not None else None
    )
    next_ends = (
        as_utc(organization.next_tariff_ends_at)
        if organization.next_tariff_ends_at is not None
        else None
    )

    # Текущий слот истёк, а будущий оплачен — будущий уже наступил. На бумаге он и
    # есть текущий; запись этого переезда делает только оплата.
    current_expired = current_ends is not None and current_ends <= moment
    if (
        organization.tariff_id is not None
        and current_expired
        and organization.next_tariff_id is not None
    ):
        return Slots(
            current_tariff_id=organization.next_tariff_id,
            current_ends_at=next_ends,
            next_tariff_id=None,
            next_ends_at=None,
        )

    return Slots(
        current_tariff_id=organization.tariff_id,
        current_ends_at=current_ends,
        next_tariff_id=organization.next_tariff_id,
        next_ends_at=next_ends,
    )


def _is_live(ends_at: datetime | None, moment: datetime) -> bool:
    """Идёт ли период: без конца — да, иначе — если конец ещё не наступил."""
    return ends_at is None or ends_at > moment


def free_slot(organization: Organization, now: datetime | None = None) -> str | None:
    """Какой слот свободен: `current`, `future` или `None` (оба заняты).

    Свободный текущий слот — это и «тарифа ещё нет», и «срок истёк, продления не
    было»: оплата в таком состоянии начинает период заново, от момента оплаты.
    """
    moment = as_utc(now or datetime.now(UTC))
    slots = organization_slots(organization, moment)

    if slots.current_tariff_id is None or not _is_live(slots.current_ends_at, moment):
        return CURRENT_SLOT
    # Бессрочный тариф и уже оплаченный будущий период одинаково не оставляют
    # места третьему: будущему периоду не от чего отсчитываться.
    if slots.current_ends_at is None or slots.next_tariff_id is not None:
        return None
    return FUTURE_SLOT


def subscription_state(
    db: Session, organization_id: int, now: datetime | None = None
) -> SubscriptionState:
    """Состояние подписки организации: действующий тариф и оплаченный вперёд."""
    organization = db.get(Organization, organization_id)
    if organization is None:
        return EMPTY_STATE
    return organization_subscription(db, organization, now)


def organization_subscription(
    db: Session, organization: Organization, now: datetime | None = None
) -> SubscriptionState:
    """Состояние подписки по уже прочитанной строке организации."""
    moment = as_utc(now or datetime.now(UTC))
    slots = organization_slots(organization, moment)

    tariff = _tariff(db, slots.current_tariff_id)
    next_tariff = _tariff(db, slots.next_tariff_id)

    # Строку тарифа могли удалить (`ON DELETE SET NULL`): слота нет, и кабинет
    # открывать нечем — это состояние «тарифа нет», а не падение чтения.
    active: Tariff | None = None
    ends_at: datetime | None = None
    upcoming: Tariff | None = None
    next_starts_at: datetime | None = None

    if tariff is not None and _is_live(slots.current_ends_at, moment):
        active, ends_at = tariff, slots.current_ends_at
        # Будущий период показывается только тогда, когда известен день начала.
        if next_tariff is not None and slots.current_ends_at is not None:
            upcoming, next_starts_at = next_tariff, slots.current_ends_at
    elif next_tariff is not None and _is_live(slots.next_ends_at, moment):
        # Текущего тарифа нет или его срок истёк, а будущий уже оплачен: действует
        # он, и слот продления свободен — это и есть кабинет без воркера.
        active, ends_at = next_tariff, slots.next_ends_at

    days_left = 0
    if active is not None and ends_at is not None:
        days_left = max(0, ceil((ends_at - moment).total_seconds() / SECONDS_PER_DAY))

    return SubscriptionState(
        tariff=active,
        ends_at=ends_at,
        days_left=days_left,
        # Предупреждение — только у периода с известным концом и только когда до
        # него осталось `EXPIRING_DAYS` суток или меньше.
        is_expiring=active is not None and ends_at is not None and 0 < days_left <= EXPIRING_DAYS,
        next_tariff=upcoming,
        next_starts_at=next_starts_at,
    )


def record_payment(
    organization: Organization,
    tariff_id: int | None,
    period: str | None,
    now: datetime | None = None,
) -> None:
    """Записать оплаченный период тарифа в подписку организации.

    Коммитит вызывающий (`app/invoice_status.py`): оплата счёта — одна
    транзакция, и частично применённой она быть не должна.

    Свободен текущий слот — заполняется он, и период начинается с момента
    оплаты. Занят — заполняется будущий, и он начинается ровно с
    `tariff_ends_at` текущего: неоплаченное время не сгорает. Оба заняты — `409`
    с текстом `TARIFF_ALREADY_BOUGHT_DETAIL`.

    Строку тарифа могли удалить из прайса до оплаты (`invoices.tariff_id`
    обнуляется): тогда записывать нечего, и подписка не меняется — оплата всё
    равно фиксируется, а кабинет остаётся как был.
    """
    if tariff_id is None:
        return
    moment = as_utc(now or datetime.now(UTC))
    slots = organization_slots(organization, moment)

    if slots.current_tariff_id is None or not _is_live(slots.current_ends_at, moment):
        # Текущий слот свободен или истёк: новый период начинается с оплаты.
        slots = Slots(
            current_tariff_id=tariff_id,
            current_ends_at=entitlement_expiry(period, moment) if period else None,
            next_tariff_id=slots.next_tariff_id,
            next_ends_at=slots.next_ends_at,
        )
    else:
        # Текущий период жив: оплата встаёт в будущий слот. Бессрочный тариф
        # будущего не имеет — продлить его нечем и не от чего.
        if slots.current_ends_at is None or slots.next_tariff_id is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_ALREADY_BOUGHT_DETAIL)
        slots = Slots(
            current_tariff_id=slots.current_tariff_id,
            current_ends_at=slots.current_ends_at,
            next_tariff_id=tariff_id,
            next_ends_at=entitlement_expiry(period, slots.current_ends_at) if period else None,
        )

    organization.tariff_id = slots.current_tariff_id
    organization.tariff_ends_at = slots.current_ends_at
    organization.next_tariff_id = slots.next_tariff_id
    organization.next_tariff_ends_at = slots.next_ends_at


def _tariff(db: Session, tariff_id: int | None) -> Tariff | None:
    """Строка прайса по ссылке из слота. `None` — слота нет или строку удалили."""
    if tariff_id is None:
        return None
    return db.get(Tariff, tariff_id)
