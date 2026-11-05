"""Ступенчатая цена мест: скидка за каждый полный десяток (issue #177).

Скидка считается на **весь набор** мест, а не только на места сверх десятка:
десять мест стоят 90 % цены каждое. Здесь проверяется только арифметика
(`app/seats.py`), без HTTP и без базы: сумму счёта сервер собирает этими
функциями, и расхождение с экраном означало бы, что человек увидел одну цену, а
получил другую.

Округление — до копеек, половина вверх, и округляется **цена места**, а не
произведение: `unit_amount × quantity` обязано совпадать с суммой до копейки,
иначе в счёте стояли бы не сходящиеся строки.
"""

from decimal import Decimal

from app.seats import (
    MAX_DISCOUNT_PERCENT,
    MAX_SEATS_PER_PURCHASE,
    SEAT_BANDS,
    discount_percent,
    seats_total,
    unit_amount,
)

# Цена места без скидки — та, что стоит в каталоге после `0065_license_prices`.
BASE = Decimal("1500.00")


def test_bands_describe_every_step_of_the_discount() -> None:
    """Шесть ступеней: 1–9, 10–19, 20–29, 30–39, 40–49, 50 и больше."""
    assert [(band.start, band.end, band.discount_percent) for band in SEAT_BANDS] == [
        (1, 9, 0),
        (10, 19, 10),
        (20, 29, 20),
        (30, 39, 30),
        (40, 49, 40),
        (50, None, 50),
    ]


def test_the_last_band_is_open_upwards() -> None:
    """Последняя ступень не имеет верхней границы: предел продажи — не ступень."""
    assert SEAT_BANDS[-1].end is None
    assert SEAT_BANDS[-1].discount_percent == MAX_DISCOUNT_PERCENT


def test_discount_grows_by_ten_percent_per_full_ten() -> None:
    """Скидка — 10 % за каждый полный десяток и не больше 50 %."""
    assert discount_percent(1) == 0
    assert discount_percent(9) == 0
    assert discount_percent(10) == 10
    assert discount_percent(19) == 10
    assert discount_percent(20) == 20
    assert discount_percent(49) == 40
    assert discount_percent(50) == 50
    assert discount_percent(99) == 50
    assert discount_percent(MAX_SEATS_PER_PURCHASE) == 50


def test_a_single_seat_costs_the_full_price() -> None:
    """Девять мест — ещё без скидки: ступень начинается с полного десятка."""
    assert unit_amount(BASE, 9) == Decimal("1500.00")
    assert seats_total(BASE, 9) == Decimal("13500.00")


def test_ten_seats_are_cheaper_each() -> None:
    """Скидка действует на весь набор: десять мест стоят 1 350 ₽ каждое.

    Не «девять по 1 500 и одно со скидкой» — это и есть правило постановки.
    """
    assert unit_amount(BASE, 10) == Decimal("1350.00")
    assert seats_total(BASE, 10) == Decimal("13500.00")


def test_fifty_seats_reach_the_discount_ceiling() -> None:
    """На пятидесяти местах скидка упирается в 50 %: 750 ₽ за место."""
    assert unit_amount(BASE, 50) == Decimal("750.00")
    assert seats_total(BASE, 50) == Decimal("37500.00")


def test_the_ceiling_does_not_grow_past_fifty_percent() -> None:
    """Сотня мест — та же половина цены: больше 50 % скидки не бывает."""
    assert unit_amount(BASE, MAX_SEATS_PER_PURCHASE) == Decimal("750.00")
    assert seats_total(BASE, MAX_SEATS_PER_PURCHASE) == Decimal("75000.00")


def test_every_band_boundary_keeps_the_previous_price_until_the_step() -> None:
    """Границы ступеней: 19 и 20, 49 и 50 меняют цену, 9 и 10 — тоже."""
    assert unit_amount(BASE, 19) == Decimal("1350.00")
    assert unit_amount(BASE, 20) == Decimal("1200.00")
    assert unit_amount(BASE, 29) == Decimal("1200.00")
    assert unit_amount(BASE, 30) == Decimal("1050.00")
    assert unit_amount(BASE, 49) == Decimal("900.00")


def test_the_unit_price_is_rounded_to_kopecks() -> None:
    """Цена места округляется до копеек половиной вверх, а не отбрасыванием."""
    assert unit_amount(Decimal("999.99"), 10) == Decimal("899.99")
    assert unit_amount(Decimal("1234.55"), 20) == Decimal("987.64")
    # 987.64 × 20 = 19 752.80 — сумма считается от уже округлённой цены.
    assert seats_total(Decimal("1234.55"), 20) == Decimal("19752.80")


def test_the_total_is_the_rounded_unit_times_the_quantity() -> None:
    """Сумма = округлённая цена места × количество: строки счёта сходятся."""
    base = Decimal("1234.55")
    quantity = 30
    assert unit_amount(base, quantity) == Decimal("864.19")
    assert seats_total(base, quantity) == Decimal("25925.70")


def test_quantity_outside_the_sale_gives_no_discount() -> None:
    """`0` и меньше — не покупка: скидки нет, деления на количество тоже нет."""
    assert discount_percent(0) == 0
    assert discount_percent(-5) == 0
