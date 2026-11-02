"""Срок действия тарифа и слоты продления (`app/subscription.py`).

Критерии готовности разложены по блокам:

* граница срока **исключающая**, как у пробного периода: в момент `ends_at`
  тариф уже не действует, секундой раньше — действует;
* оплаченный вперёд период становится действующим без фонового воркера, если
  текущий слот истёк, и показывается отдельно, пока текущий жив;
* предупреждение `is_expiring` включается на остатке 14 суток и меньше; 15 суток
  — уже нет;
* слоты продления: пустая подписка и истёкший срок дают текущий слот, живой
  период — будущий, оба занятых (и бессрочный тариф) — ни одного;
* `record_payment` начинает период от оплаты, заполняет будущий слот от конца
  текущего и отказывает `409` на третий период.

Тесты идут на SQLite без HTTP: срок — это вычисление, и проверяется оно без
ручек. Тексты и коды отказа через API — в `tests/test_billing.py`.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.organization import Organization
from app.models.tariff import Tariff
from app.subscription import (
    CURRENT_SLOT,
    EXPIRING_DAYS,
    FUTURE_SLOT,
    TARIFF_ALREADY_BOUGHT_DETAIL,
    free_slot,
    organization_subscription,
    record_payment,
    subscription_state,
)
from tests.conftest import create_user, organizations_for

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)
MONTH_LATER = datetime(2026, 12, 2, 12, 0, tzinfo=UTC)
QUARTER_LATER = datetime(2027, 3, 2, 12, 0, tzinfo=UTC)


def add_tariff(
    db_session: Session,
    name: str = "Месяц",
    period: str = "month",
    max_members: int | None = None,
) -> Tariff:
    """Строка прайса прямо в базе: подписке нужна только она."""
    tariff = Tariff(
        name=name,
        description=None,
        amount=Decimal("10000.00"),
        currency="RUB",
        period=period,
        max_members=max_members,
        position=1,
        is_visible=True,
    )
    db_session.add(tariff)
    db_session.commit()
    db_session.refresh(tariff)
    return tariff


def organization(db_session: Session) -> Organization:
    """Организация без тарифа: подписка собирается тестом по шагам."""
    user = create_user(db_session, email="owner@example.com")
    organization_row, _ = organizations_for(db_session, user)
    return organization_row


def bind(
    db_session: Session,
    organization_row: Organization,
    tariff: Tariff | None,
    ends_at: datetime | None,
    *,
    next_tariff: Tariff | None = None,
    next_ends_at: datetime | None = None,
) -> None:
    """Записать слоты так, как это сделала бы оплата счёта."""
    organization_row.tariff_id = tariff.id if tariff is not None else None
    organization_row.tariff_ends_at = ends_at
    organization_row.next_tariff_id = next_tariff.id if next_tariff is not None else None
    organization_row.next_tariff_ends_at = next_ends_at
    db_session.commit()


# --- 1. Состояние подписки ----------------------------------------------------


def test_organization_without_a_tariff_has_no_subscription(db_session: Session) -> None:
    organization_row = organization(db_session)

    state = subscription_state(db_session, organization_row.id, NOW)

    assert state.tariff is None
    assert state.is_active is False
    assert state.ends_at is None
    assert state.days_left == 0
    assert state.is_expiring is False
    assert state.next_tariff is None
    assert state.next_starts_at is None


def test_subscription_of_an_unknown_organization_is_empty(db_session: Session) -> None:
    state = subscription_state(db_session, 999, NOW)

    assert state.tariff is None
    assert state.is_active is False


def test_tariff_without_an_end_is_indefinite(db_session: Session) -> None:
    """`tariff_ends_at = NULL` — бессрочный тариф администратора, а не «нет срока»."""
    organization_row = organization(db_session)
    tariff = add_tariff(db_session)
    bind(db_session, organization_row, tariff, None)

    state = subscription_state(db_session, organization_row.id, NOW)

    assert state.tariff is not None and state.tariff.id == tariff.id
    assert state.is_active is True
    assert state.ends_at is None
    assert state.days_left == 0
    assert state.is_expiring is False


def test_days_left_rounds_up(db_session: Session) -> None:
    organization_row = organization(db_session)
    tariff = add_tariff(db_session)
    bind(db_session, organization_row, tariff, NOW + timedelta(days=9, hours=1))

    state = subscription_state(db_session, organization_row.id, NOW)

    assert state.days_left == 10
    assert state.is_expiring is True


def test_expiring_starts_at_fourteen_days(db_session: Session) -> None:
    """14 суток — предупреждение есть, 15 — уже нет: считает сервер."""
    organization_row = organization(db_session)
    tariff = add_tariff(db_session)
    bind(db_session, organization_row, tariff, NOW + timedelta(days=EXPIRING_DAYS))

    expiring = subscription_state(db_session, organization_row.id, NOW)

    assert expiring.days_left == EXPIRING_DAYS
    assert expiring.is_expiring is True

    bind(db_session, organization_row, tariff, NOW + timedelta(days=EXPIRING_DAYS, seconds=1))

    calm = subscription_state(db_session, organization_row.id, NOW)

    assert calm.days_left == EXPIRING_DAYS + 1
    assert calm.is_expiring is False


def test_boundary_is_exclusive(db_session: Session) -> None:
    """В момент `ends_at` тариф уже не действует, секундой раньше — действует."""
    organization_row = organization(db_session)
    tariff = add_tariff(db_session)

    bind(db_session, organization_row, tariff, NOW + timedelta(seconds=1))
    before = subscription_state(db_session, organization_row.id, NOW)
    assert before.tariff is not None
    assert before.days_left == 1

    bind(db_session, organization_row, tariff, NOW)
    at_the_moment = subscription_state(db_session, organization_row.id, NOW)
    assert at_the_moment.tariff is None
    assert at_the_moment.is_active is False
    assert at_the_moment.ends_at is None


def test_future_period_is_shown_while_the_current_one_is_alive(db_session: Session) -> None:
    organization_row = organization(db_session)
    current = add_tariff(db_session, name="Месяц")
    future = add_tariff(db_session, name="Квартал", period="quarter")
    bind(
        db_session,
        organization_row,
        current,
        MONTH_LATER,
        next_tariff=future,
        next_ends_at=QUARTER_LATER,
    )

    state = subscription_state(db_session, organization_row.id, NOW)

    assert state.tariff is not None and state.tariff.id == current.id
    assert state.ends_at == MONTH_LATER
    assert state.next_tariff is not None and state.next_tariff.id == future.id
    # Будущий период начинается ровно в момент конца текущего: граница исключающая.
    assert state.next_starts_at == MONTH_LATER


def test_future_period_becomes_current_without_a_worker(db_session: Session) -> None:
    """Текущий слот истёк, будущий оплачен — действует будущий, слот свободен."""
    organization_row = organization(db_session)
    current = add_tariff(db_session, name="Месяц")
    future = add_tariff(db_session, name="Квартал", period="quarter")
    bind(
        db_session,
        organization_row,
        current,
        NOW - timedelta(days=1),
        next_tariff=future,
        next_ends_at=QUARTER_LATER,
    )

    state = subscription_state(db_session, organization_row.id, NOW)

    assert state.tariff is not None and state.tariff.id == future.id
    assert state.ends_at == QUARTER_LATER
    assert state.next_tariff is None
    assert free_slot(organization_row, NOW) == FUTURE_SLOT


def test_expired_period_without_a_future_leaves_no_tariff(db_session: Session) -> None:
    organization_row = organization(db_session)
    tariff = add_tariff(db_session)
    bind(db_session, organization_row, tariff, NOW - timedelta(seconds=1))

    state = subscription_state(db_session, organization_row.id, NOW)

    assert state.tariff is None
    assert state.is_active is False
    assert free_slot(organization_row, NOW) == CURRENT_SLOT


def test_deleted_tariff_row_leaves_the_organization_without_a_tariff(
    db_session: Session,
) -> None:
    """Строку прайса удалили — внешний ключ обнулил ссылку; чтение не падает."""
    organization_row = organization(db_session)
    bind(db_session, organization_row, None, None)

    state = organization_subscription(db_session, organization_row, NOW)

    assert state.tariff is None
    assert state.is_active is False


# --- 2. Слоты продления -------------------------------------------------------


def test_free_slot_of_an_empty_subscription_is_current(db_session: Session) -> None:
    organization_row = organization(db_session)

    assert free_slot(organization_row, NOW) == CURRENT_SLOT


def test_free_slot_after_a_live_payment_is_future(db_session: Session) -> None:
    organization_row = organization(db_session)
    tariff = add_tariff(db_session)
    bind(db_session, organization_row, tariff, MONTH_LATER)

    assert free_slot(organization_row, NOW) == FUTURE_SLOT


def test_both_paid_slots_leave_no_slot(db_session: Session) -> None:
    organization_row = organization(db_session)
    current = add_tariff(db_session, name="Месяц")
    future = add_tariff(db_session, name="Квартал", period="quarter")
    bind(
        db_session,
        organization_row,
        current,
        MONTH_LATER,
        next_tariff=future,
        next_ends_at=QUARTER_LATER,
    )

    assert free_slot(organization_row, NOW) is None


def test_indefinite_tariff_leaves_no_slot(db_session: Session) -> None:
    """Продлевать бессрочный тариф нечем: будущему периоду не от чего считаться."""
    organization_row = organization(db_session)
    tariff = add_tariff(db_session)
    bind(db_session, organization_row, tariff, None)

    assert free_slot(organization_row, NOW) is None


# --- 3. Запись оплаты ---------------------------------------------------------


def test_payment_starts_the_period_from_the_payment_moment(db_session: Session) -> None:
    organization_row = organization(db_session)
    tariff = add_tariff(db_session)

    record_payment(organization_row, tariff.id, "month", NOW)

    assert organization_row.tariff_id == tariff.id
    assert organization_row.tariff_ends_at == MONTH_LATER
    assert organization_row.next_tariff_id is None
    assert organization_row.next_tariff_ends_at is None


def test_payment_fills_the_future_slot_from_the_current_end(db_session: Session) -> None:
    """Начало будущего периода — конец текущего, а не «сейчас»."""
    organization_row = organization(db_session)
    current = add_tariff(db_session, name="Месяц")
    quarter = add_tariff(db_session, name="Квартал", period="quarter")
    bind(db_session, organization_row, current, MONTH_LATER)

    record_payment(organization_row, quarter.id, "quarter", NOW)

    assert organization_row.tariff_id == current.id
    assert organization_row.tariff_ends_at == MONTH_LATER
    assert organization_row.next_tariff_id == quarter.id
    # 02.12.2026 + 3 месяца, а не «сейчас + 3 месяца».
    assert organization_row.next_tariff_ends_at == QUARTER_LATER


def test_payment_after_the_expiry_starts_a_new_period_from_now(db_session: Session) -> None:
    """Истёкший срок не «докручивается»: новый период начинается с оплаты."""
    organization_row = organization(db_session)
    current = add_tariff(db_session, name="Месяц")
    new = add_tariff(db_session, name="Рост")
    bind(db_session, organization_row, current, NOW - timedelta(days=10))

    record_payment(organization_row, new.id, "month", NOW)

    assert organization_row.tariff_id == new.id
    assert organization_row.tariff_ends_at == MONTH_LATER
    assert organization_row.next_tariff_id is None


def test_payment_after_the_future_period_started_moves_it_into_current(
    db_session: Session,
) -> None:
    """Наступивший будущий период переезжает в текущий слот, и продление идёт за ним."""
    organization_row = organization(db_session)
    current = add_tariff(db_session, name="Месяц")
    future = add_tariff(db_session, name="Квартал", period="quarter")
    new = add_tariff(db_session, name="Год", period="year")
    bind(
        db_session,
        organization_row,
        current,
        NOW - timedelta(days=1),
        next_tariff=future,
        next_ends_at=QUARTER_LATER,
    )

    record_payment(organization_row, new.id, "year", NOW)

    assert organization_row.tariff_id == future.id
    assert organization_row.tariff_ends_at == QUARTER_LATER
    assert organization_row.next_tariff_id == new.id
    assert organization_row.next_tariff_ends_at == datetime(2028, 3, 2, 12, 0, tzinfo=UTC)


def test_third_payment_before_the_future_is_a_conflict(db_session: Session) -> None:
    organization_row = organization(db_session)
    current = add_tariff(db_session, name="Месяц")
    future = add_tariff(db_session, name="Квартал", period="quarter")
    third = add_tariff(db_session, name="Год", period="year")
    bind(
        db_session,
        organization_row,
        current,
        MONTH_LATER,
        next_tariff=future,
        next_ends_at=QUARTER_LATER,
    )

    with pytest.raises(HTTPException) as raised:
        record_payment(organization_row, third.id, "year", NOW)

    assert raised.value.status_code == 409
    assert raised.value.detail == TARIFF_ALREADY_BOUGHT_DETAIL
    # Отказ ничего не записал: оба прежних периода на месте.
    assert organization_row.tariff_id == current.id
    assert organization_row.next_tariff_id == future.id


def test_payment_of_a_deleted_tariff_keeps_the_subscription(db_session: Session) -> None:
    """Счёт ссылается на удалённую строку прайса: подписку не портим."""
    organization_row = organization(db_session)
    tariff = add_tariff(db_session)
    bind(db_session, organization_row, tariff, MONTH_LATER)

    record_payment(organization_row, None, "month", NOW)

    assert organization_row.tariff_id == tariff.id
    assert organization_row.tariff_ends_at == MONTH_LATER
