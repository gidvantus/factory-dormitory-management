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
from datetime import UTC, date, datetime, time, timedelta
from math import ceil
from zoneinfo import ZoneInfo

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

# Пояс оператора: срок из кабинета задаётся днём по Москве, а не по UTC. Оператор
# пишет «действует по 30.06.2027» и ждёт, что это будет 30 июня по Москве.
MOSCOW = ZoneInfo("Europe/Moscow")

# Последняя включённая секунда суток — с микросекундами, потому что граница
# `ends_at` исключающая: день `D` кончается в `D 23:59:59.999999`, и ровно в этот
# момент тариф уже не действует.
END_OF_DAY = time(23, 59, 59, 999999)


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
class Slot:
    """**Записанный** слот подписки: строка прайса и срок — как они лежат в базе.

    Это не то же, что `Slots`: здесь нет «виртуального переезда» наступившего
    будущего периода. Кабинет оператора показывает запись, а не вычисление: если
    срок текущего слота истёк, он так и виден — с `is_live = false`, — даже когда
    уже оплачен следующий. «Что действует сейчас» по-прежнему решают
    `organization_slots` и `organization_subscription`; для клиентского кабинета
    не меняется ничего.

    Строки тарифа может не быть: `tariff_id` объявлен `ON DELETE SET NULL` и
    обнуляется при удалении строки прайса, поэтому `tariff` бывает `None` при
    непустом `ends_at`. Срок при этом остаётся — он и есть запись подписки.
    """

    tariff: Tariff | None
    ends_at: datetime | None


@dataclass(frozen=True)
class SubscriptionState:
    """Действующий тариф и то, что оплачено вперёд.

    `days_left` — целые сутки до конца, округлённые вверх (неполный последний
    день считается за полный), как у пробного периода. У бессрочного тарифа и у
    закрытого кабинета остаётся `0`: считать нечего.

    `extra_seats` — докупленные сверх тарифа места (`organizations.extra_seats`).
    Они не привязаны ни к ярусу, ни к сроку: место живёт вместе с подпиской, и в
    состояние оно попало затем, чтобы предел считался в одном месте — здесь, а не
    сложением в ручке.
    """

    tariff: Tariff | None
    ends_at: datetime | None
    days_left: int
    is_expiring: bool
    next_tariff: Tariff | None
    next_starts_at: datetime | None
    extra_seats: int = 0

    @property
    def is_active(self) -> bool:
        """Работает ли кабинет по тарифу прямо сейчас."""
        return self.tariff is not None

    @property
    def member_limit(self) -> int | None:
        """Предел мест: `max_members` тарифа плюс докупленные места.

        `None` — без ограничения: так продаётся безлимитный ярус, и докупить
        места на нём нечего. Без действующего тарифа предела по подписке тоже
        нет — там работает настройка пробного периода (`app/trial.py`).
        """
        if self.tariff is None or self.tariff.max_members is None:
            return None
        return self.tariff.max_members + self.extra_seats


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


def current_slot(db: Session, organization: Organization) -> Slot:
    """Записанный текущий слот: `tariff_id` + `tariff_ends_at` как они есть.

    Переезда «наступившего» будущего периода здесь нет намеренно: это чтение
    записи для кабинета оператора, а не ответ «что действует сейчас». Второй
    копии правила слотов (`organization_slots`) не заводится: срок и строку
    прайса берём прямо из колонок.
    """
    return Slot(
        tariff=_tariff(db, organization.tariff_id),
        ends_at=_ends_at(organization.tariff_ends_at),
    )


def next_slot(db: Session, organization: Organization) -> Slot:
    """Записанный оплаченный вперёд слот: `next_tariff_id` + `next_tariff_ends_at`."""
    return Slot(
        tariff=_tariff(db, organization.next_tariff_id),
        ends_at=_ends_at(organization.next_tariff_ends_at),
    )


def is_live(ends_at: datetime | None, now: datetime | None = None) -> bool:
    """Идёт ли период: без конца — да, иначе — если конец ещё не наступил.

    Функция публичная, потому что правило одно на весь проект: её зовут и слоты
    продления, и чтение записанного слота в кабинете оператора. Вторая копия
    этого сравнения разошлась бы с первой на первой же правке границы.
    """
    moment = as_utc(now or datetime.now(UTC))
    return ends_at is None or as_utc(ends_at) > moment


def days_left(ends_at: datetime | None, now: datetime | None = None) -> int:
    """Целые сутки до конца срока, округлённые вверх.

    Неполный последний день считается за полный — как у пробного периода. У
    истёкшего срока и у бессрочного — `0`: считать нечего.
    """
    if ends_at is None:
        return 0
    moment = as_utc(now or datetime.now(UTC))
    return max(0, ceil((as_utc(ends_at) - moment).total_seconds() / SECONDS_PER_DAY))


def paid_until(ends_at: datetime | None) -> date | None:
    """Последний **включённый** день срока по Москве. `None` — бессрочно.

    Граница `ends_at` исключающая, поэтому последний включённый день — это день
    момента «за микросекунду до конца». Считать его в МСК, а не в UTC, важно:
    срок записывается концом московских суток, и обратное чтение должно дать тот
    же день, который ввёл оператор.
    """
    if ends_at is None:
        return None
    return (as_utc(ends_at) - timedelta(microseconds=1)).astimezone(MOSCOW).date()


def set_current_end(organization: Organization, paid_until: date) -> None:
    """Записать последний включённый день в текущий слот. Коммитит вызывающий.

    В колонку ложится момент `paid_until 23:59:59.999999` по Москве, приведённый к
    UTC: сам момент от этого не меняется, а SQLite (юнит-тесты) зону не хранит и
    отдаёт naive значение, которое чтение считает UTC (`as_utc`). В PostgreSQL
    `timestamptz` хранит тот же момент — поведение на обеих базах одинаковое.

    `next_*` не трогаются: оператор правит ровно текущий слот. Бессрочный тариф
    (`tariff_ends_at IS NULL`) от этого становится срочным — это и есть правка
    срока, а не новая запись: `tariff_id` остаётся на месте.
    """
    organization.tariff_ends_at = datetime.combine(
        paid_until, END_OF_DAY, tzinfo=MOSCOW
    ).astimezone(UTC)


def deactivate_current(organization: Organization, now: datetime | None = None) -> None:
    """Снять активность текущего тарифа: `tariff_ends_at` = момент вызова в UTC.

    Ничего не удаляется и не обнуляется: «не действует» в проекте — это срок в
    прошлом, а не флаг (разбор #189). Отсюда и идемпотентность: повторный вызов
    снова ставит срок в «сейчас», и ответ остаётся тем же состоянием «не
    действует». Коммитит вызывающий.

    `next_*` не трогаются: оплаченный вперёд слот остаётся как был. Если он есть,
    после снятия текущего действующим станет он (`organization_slots`) — это
    ожидаемое следствие правила, а не дефект.
    """
    organization.tariff_ends_at = as_utc(now or datetime.now(UTC))


def free_slot(organization: Organization, now: datetime | None = None) -> str | None:
    """Какой слот свободен: `current`, `future` или `None` (оба заняты).

    Свободный текущий слот — это и «тарифа ещё нет», и «срок истёк, продления не
    было»: оплата в таком состоянии начинает период заново, от момента оплаты.
    """
    moment = as_utc(now or datetime.now(UTC))
    slots = organization_slots(organization, moment)

    if slots.current_tariff_id is None or not is_live(slots.current_ends_at, moment):
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

    if tariff is not None and is_live(slots.current_ends_at, moment):
        active, ends_at = tariff, slots.current_ends_at
        # Будущий период показывается только тогда, когда известен день начала.
        if next_tariff is not None and slots.current_ends_at is not None:
            upcoming, next_starts_at = next_tariff, slots.current_ends_at
    elif next_tariff is not None and is_live(slots.next_ends_at, moment):
        # Текущего тарифа нет или его срок истёк, а будущий уже оплачен: действует
        # он, и слот продления свободен — это и есть кабинет без воркера.
        active, ends_at = next_tariff, slots.next_ends_at

    # Остаток считается одним правилом (`days_left`), а не второй его копией:
    # кабинет оператора читает те же сутки тем же вызовом.
    left = 0 if active is None else days_left(ends_at, moment)

    return SubscriptionState(
        tariff=active,
        ends_at=ends_at,
        days_left=left,
        # Предупреждение — только у периода с известным концом и только когда до
        # него осталось `EXPIRING_DAYS` суток или меньше.
        is_expiring=active is not None and ends_at is not None and 0 < left <= EXPIRING_DAYS,
        next_tariff=upcoming,
        next_starts_at=next_starts_at,
        # Докупленные места не зависят от слотов: платили за них отдельно, и
        # продление тарифа их не сбрасывает.
        extra_seats=organization.extra_seats or 0,
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

    if slots.current_tariff_id is None or not is_live(slots.current_ends_at, moment):
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


def _ends_at(value: datetime | None) -> datetime | None:
    """Срок слота в UTC. `None` — бессрочно (или слота нет).

    Значение из базы приводится к UTC и в ответе ручки: SQLite отдаёт naive
    datetime, и без приведения в JSON уехала бы строка без зоны, а клиент не может
    знать, какой пояс она означает. Момент при этом не меняется.
    """
    return None if value is None else as_utc(value)
