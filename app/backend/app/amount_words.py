"""Сумма прописью для печатных форм счёта и акта.

В счёте и акте сумма стоит дважды: цифрами в таблице и прописью под итогом —
это требование первичного документа, а не украшение. Прописью сумма пишется
словами с падежом валюты и копеек: «Две тысячи рублей 00 копеек».

Правила русского счёта:

* разряды идут тройками — тысячи, миллионы, миллиарды;
* в тысячах числительное женского рода («одна тысяча», «две тысячи»), в
  остальных разрядах — мужского («один миллион», «два миллиона»);
* слово после числа склоняется по последним двум цифрам: 1 — рубль, 2–4 —
  рубля, 5–20 и 0 — рублей; 11–14 всегда «рублей» («одиннадцать рублей»).

Модуль ничего не знает ни про счёт, ни про базу: на вход сумма и код валюты,
на выход строка. Поэтому его можно проверить обычным юнит-тестом.
"""

from decimal import ROUND_HALF_UP, Decimal

# Числительные по разрядам. Форма женского рода отличается только у единиц:
# «одна тысяча», а не «один тысяча».
UNITS = ("", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять")
UNITS_FEMININE = ("", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять")
TEENS = (
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
)
TENS = (
    "",
    "",
    "двадцать",
    "тридцать",
    "сорок",
    "пятьдесят",
    "шестьдесят",
    "семьдесят",
    "восемьдесят",
    "девяносто",
)
HUNDREDS = (
    "",
    "сто",
    "двести",
    "триста",
    "четыреста",
    "пятьсот",
    "шестьсот",
    "семьсот",
    "восемьсот",
    "девятьсот",
)

# Названия разрядов: единственное, 2–4 и остальные. У единиц своего слова нет —
# «два» уже само число.
GROUP_WORDS = (
    ("", "", ""),
    ("тысяча", "тысячи", "тысяч"),
    ("миллион", "миллиона", "миллионов"),
    ("миллиард", "миллиарда", "миллиардов"),
)

# Разряд, в котором числительное женского рода: тысяча — она. Порядок разрядов
# совпадает с `GROUP_WORDS`: единицы, тысячи, миллионы, миллиарды.
FEMININE = (False, True, False, False)

# Названия валюты и её копеек: (единственное, 2–4, остальные). Евро не
# склоняется, поэтому у него все три формы совпадают.
CURRENCY_WORDS: dict[str, tuple[tuple[str, str, str], tuple[str, str, str]]] = {
    "RUB": (("рубль", "рубля", "рублей"), ("копейка", "копейки", "копеек")),
    "USD": (("доллар", "доллара", "долларов"), ("цент", "цента", "центов")),
    "EUR": (("евро", "евро", "евро"), ("цент", "цента", "центов")),
}

# Сумма в форме, в которой она попадает в документ: копейки всегда двузначные.
MONEY_QUANTUM = Decimal("0.01")

# Копейки и валюта печатаются двумя знаками: «00 копеек», а не «0 копеек».
FRACTION_FORMAT = "02d"

# Наибольший разряд, который умеет модуль: больше миллиардов в счёте не бывает,
# а молча потерять разряд хуже, чем отказать.
MAX_GROUPS = len(GROUP_WORDS)


def _plural(count: int, forms: tuple[str, str, str]) -> str:
    """Форма слова по числу: 1 — рубль, 2 — рубля, 5 и 11 — рублей."""
    tens = count % 100
    if 11 <= tens <= 19:
        return forms[2]
    units = tens % 10
    if units == 1:
        return forms[0]
    if 2 <= units <= 4:
        return forms[1]
    return forms[2]


def _triple_words(value: int, *, feminine: bool) -> list[str]:
    """Слова для числа от 0 до 999: сотни, десятки, единицы."""
    words: list[str] = []
    hundreds, rest = divmod(value, 100)
    if hundreds:
        words.append(HUNDREDS[hundreds])
    tens, units = divmod(rest, 10)
    if tens == 1:
        words.append(TEENS[units])
    else:
        if tens:
            words.append(TENS[tens])
        if units:
            words.append(UNITS_FEMININE[units] if feminine else UNITS[units])
    return words


def integer_in_words(value: int) -> str:
    """Целое число словами: «две тысячи сорок» для 2040."""
    if value == 0:
        return "ноль"
    if value < 0:
        return f"минус {integer_in_words(-value)}"
    if value >= 1000**MAX_GROUPS:
        raise ValueError(
            f"Сумма {value} больше, чем печатная форма умеет написать прописью: "
            f"разрядов больше {MAX_GROUPS - 1}."
        )
    triples: list[int] = []
    rest = value
    while rest:
        rest, triple = divmod(rest, 1000)
        triples.append(triple)
    # `triples` собирается снизу вверх, а читается сверху вниз.
    words: list[str] = []
    for index in range(len(triples) - 1, -1, -1):
        triple = triples[index]
        if not triple:
            continue
        words.extend(_triple_words(triple, feminine=FEMININE[index]))
        if index:
            words.append(_plural(triple, GROUP_WORDS[index]))
    return " ".join(words)


def amount_in_words(amount: Decimal, currency: str) -> str:
    """Сумма прописью: «Две тысячи рублей 00 копеек».

    Валюта, которой нет в словаре, печатается своим кодом, а её дробная часть —
    числом без слова: «рублей» и «копеек» — это склонение рубля, и подставлять
    его чужой валюте значило бы выдумать слова, которых у неё нет. Уронить
    печать документа из-за незнакомой валюты — тем более нельзя.
    """
    quantized = amount.quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)
    whole = int(quantized)
    fraction = int(abs(quantized - whole) * 100)
    words = integer_in_words(whole)
    # Первое слово — с заглавной: сумма прописью открывает строку документа.
    text = f"{words[0].upper()}{words[1:]}"
    if currency not in CURRENCY_WORDS:
        return f"{text} {currency} {fraction:{FRACTION_FORMAT}}"
    currency_forms, fraction_forms = CURRENCY_WORDS[currency]
    return (
        f"{text} {_plural(whole, currency_forms)} "
        f"{fraction:{FRACTION_FORMAT}} {_plural(fraction, fraction_forms)}"
    )
