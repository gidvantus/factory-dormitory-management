"""Сумма прописью в печатных формах счёта и акта (#179).

Проверяются места, где русский счёт ломается чаще всего: женский род у тысяч
(«две тысячи», а не «два тысячи»), форма слова после 11–14 («одиннадцать
рублей»), нулевые копейки и склонение копеек отдельно от рублей.
"""

from decimal import Decimal

import pytest

from app.amount_words import amount_in_words, integer_in_words


@pytest.mark.parametrize(
    ("amount", "expected"),
    [
        ("0", "Ноль рублей 00 копеек"),
        ("1", "Один рубль 00 копеек"),
        ("2.00", "Два рубля 00 копеек"),
        ("5", "Пять рублей 00 копеек"),
        ("11", "Одиннадцать рублей 00 копеек"),
        ("21", "Двадцать один рубль 00 копеек"),
        ("1001", "Одна тысяча один рубль 00 копеек"),
        ("2000", "Две тысячи рублей 00 копеек"),
        ("12000", "Двенадцать тысяч рублей 00 копеек"),
        ("2000000", "Два миллиона рублей 00 копеек"),
        ("1350.50", "Одна тысяча триста пятьдесят рублей 50 копеек"),
        ("100.01", "Сто рублей 01 копейка"),
        ("100.02", "Сто рублей 02 копейки"),
    ],
)
def test_ruble_amount_is_spelled_with_the_right_case(amount: str, expected: str) -> None:
    assert amount_in_words(Decimal(amount), "RUB") == expected


def test_kopecks_are_spelled_by_their_own_number() -> None:
    """Рубли склоняются по целой части, копейки — по своей: «рублей 02 копейки»."""
    assert amount_in_words(Decimal("0.02"), "RUB") == "Ноль рублей 02 копейки"


def test_kopecks_are_rounded_to_two_digits() -> None:
    """Копейки — деньги: третья цифра округляется, а не отрезается."""
    assert amount_in_words(Decimal("10.005"), "RUB") == "Десять рублей 01 копейка"


def test_other_currencies_are_spelled_with_their_own_words() -> None:
    assert amount_in_words(Decimal("5"), "USD") == "Пять долларов 00 центов"


def test_a_currency_without_words_is_printed_by_its_code() -> None:
    """Незнакомую валюту не склоняют выдуманными словами и не роняют печать.

    Дробная часть у неё печатается числом: «копеек» — слово рубля, и подставлять
    его чужой валюте значит выдумать склонение, которого у неё нет.
    """
    assert amount_in_words(Decimal("5"), "KZT") == "Пять KZT 00"
    assert amount_in_words(Decimal("12.34"), "KZT") == "Двенадцать KZT 34"


def test_too_large_an_amount_is_refused_loudly() -> None:
    """Разряд, которого модуль не знает, — ошибка, а не молча потерянный триллион."""
    with pytest.raises(ValueError, match="прописью"):
        integer_in_words(1000**4)
