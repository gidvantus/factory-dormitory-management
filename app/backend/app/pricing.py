"""Формат цены для публичной страницы тарифов.

Цену собирает сервер, а не браузер: «5 000 ₽ в месяц» — это одна и та же строка
на странице, в кабинете и в любом другом потребителе API, и правила разделителей
(неразрывный пробел в разрядах, запятая у копеек) описаны в одном месте.

Строка не ломается по разрядам: разделитель разрядов — неразрывный пробел
(`\\u00a0`), а не обычный.
"""

from decimal import ROUND_HALF_UP, Decimal

# Символы валют. Незнакомый код показывается как есть: «KZT 5 000».
CURRENCY_SYMBOLS = {"RUB": "₽", "USD": "$", "EUR": "€"}

# Окончание цены по периоду списания.
PERIOD_SUFFIXES = {"month": "в месяц", "year": "в год", "once": "разово"}

# Неразрывный пробел: разряды не должны разрываться переносом строки.
GROUP_SEPARATOR = "\u00a0"


def format_amount(amount: Decimal) -> str:
    """«5 000» и «1 250,50»: разряды — неразрывным пробелом, копейки — запятой.

    Нулевые копейки не показываются: «5 000», а не «5 000,00». Сумма всегда
    неотрицательна — это гарантирует и схема запроса, и `CHECK` в таблице.
    """
    quantized = amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    whole, _, fraction = f"{quantized:.2f}".partition(".")
    grouped = f"{int(whole):,}".replace(",", GROUP_SEPARATOR)
    return grouped if fraction == "00" else f"{grouped},{fraction}"


def format_price(amount: Decimal, currency: str, period: str, unit_label: str | None = None) -> str:
    """Готовая строка цены: «5 000 ₽», «1 250,50 ₽ за одно место в месяц».

    Уточнение «за что» стоит перед периодом, а не после: «за одно место в месяц»
    читается как одна фраза.
    """
    symbol = CURRENCY_SYMBOLS.get(currency, currency)
    parts = [f"{format_amount(amount)} {symbol}"]
    if unit_label:
        parts.append(unit_label)
    parts.append(PERIOD_SUFFIXES.get(period, period))
    return " ".join(parts)
