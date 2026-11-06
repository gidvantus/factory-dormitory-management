"""Сборка PDF печатных форм счёта и акта.

Формы собираются кодом, без шаблонизатора: разметка маленькая и целиком наша, а
лишняя зависимость в образе API стоит дороже, чем страница из двух таблиц. PDF
вместо HTML выбран потому, что файл счёта открывается одним и тем же в браузере
и в системном просмотрщике, а не скачивается разметкой.

Экранировать значения больше не нужно: `html.escape` защищал разметку HTML, а в
PDF строка уходит в файл как есть, поэтому `<` и `&` из карточки организации
доходят до текста без HTML-сущностей.

Шрифт с кириллицей встраивается из образа (`fonts-dejavu-core`), а не лежит в
git: в core-шрифтах PDF кириллицы нет, и молчаливая подстановка Helvetica дала
бы пустые квадраты вместо букв — поэтому отсутствие файла шрифта это ошибка, а
не запасной вариант.

Данные покупателя берутся из снимка в счёте, а не из карточки организации: счёт
показывает то, что было в момент покупки.

**Вид документа.** Раскладка повторяет образец счёта, принятый в #179: знак
сервиса на отдельной строке, ниже — заголовок по центру ширины страницы, блоки
«Исполнитель» и «Заказчик» в две колонки, таблица позиций, итог, сумма прописью,
строка про НДС, подпись исполнителя и банковские реквизиты. Заголовок стоит под
знаком, а не рядом с ним: знак — эмблема, а не часть заголовка, и на узкой
странице они делят одну строку только за счёт сужения друг друга.

* Блок исполнителя печатает только заполненные реквизиты: пустые строки не
  печатаются и не добиваются прочерками. Не заполнено ни одного реквизита (или
  `company is None`) — печатается заглушка `SUPPLIER_PLACEHOLDER` одним абзацем:
  прочерки вместо названия и банка выглядели бы как реквизиты, которых нет.
* Банковские реквизиты отделены от блока исполнителя и печатаются, только если
  заполнено хотя бы одно из них: пустая шапка «Банковские реквизиты» ничего не
  сообщает.
* Строка про НДС — тот же абзац в обеих формах: в проекте один налоговый режим
  и один поставщик, и второй источник разошёлся бы с первым. Пустой `vat_note` —
  строки нет вовсе.
* Знак сервиса — SVG-ассет в образе (`app/assets/logo.svg`). Отсутствие файла —
  `RuntimeError` с внятным текстом, ровно как у шрифта: PDF без знака молча
  выдавать нельзя.

Модуль ничего не читает из базы и ничего не пишет на диск: на вход идут готовые
поля счёта, а наружу — готовые байты, поэтому его можно проверять тестом без
HTTP, без сессии и без файловой системы.
"""

import re
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fpdf import FPDF
from fpdf.enums import XPos, YPos

from app.amount_words import amount_in_words
from app.models.company_details import CompanyDetails
from app.models.invoice import (
    SEATS_ITEM_KIND,
    SOLUTION_ITEM_KIND,
    TARIFF_ITEM_KIND,
    Invoice,
    InvoiceItem,
    subject_items,
)
from app.pricing import CURRENCY_SYMBOLS, PERIOD_SUFFIXES, format_amount

# Семейство и файлы шрифта. Путь — из пакета образа: бинарники в git не кладём.
FONT_FAMILY = "DejaVu"
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# Знак сервиса: SVG рядом с модулем. В образ попадает существующим `COPY app ./app`
# (`app/backend/Dockerfile`), отдельного тома и настройки у него нет намеренно:
# знак — часть формы, а не данные. `fpdf2` рисует SVG сам, бинарник не нужен.
LOGO_PATH = Path(__file__).parent / "assets" / "logo.svg"

# Заглушка блока исполнителя: печатается, пока не заполнено ни одного реквизита.
SUPPLIER_PLACEHOLDER = "данные поставщика будут заполнены позже"

# Подписи блоков. «Исполнитель» и «Заказчик» — термины первичного документа,
# а не названия ролей в сервисе: счёт выставляет исполнитель, платит заказчик.
EXECUTOR_HEADING = "ИСПОЛНИТЕЛЬ"
CUSTOMER_HEADING = "ЗАКАЗЧИК"
BANK_HEADING = "Банковские реквизиты"

# Реквизиты, из которых собирается шапка блока исполнителя/заказчика: ИНН и КПП
# стоят одной строкой через «·», как в образце счёта.
TAX_ROWS = (("inn", "ИНН"), ("kpp", "КПП"))

# Банковские реквизиты: подпись и поле модели. Порядок — часть вида документа.
BANK_ROWS = (
    ("Банк", "bank_name"),
    ("БИК", "bank_bic"),
    ("Расчётный счёт", "bank_account"),
    ("Корреспондентский счёт", "corr_account"),
)

# Все реквизиты исполнителя. По этому набору решается, заполнено ли хоть что-то:
# когда пусто всё, вместо блока печатается заглушка.
REQUISITE_FIELDS = (
    "name",
    "inn",
    "kpp",
    "ogrn",
    "address",
    "bank_name",
    "bank_bic",
    "bank_account",
    "corr_account",
    "signatory",
)

# Заголовки колонок таблицы позиций и подпись итоговой строки.
NUMBER_HEADER = "№"
NAME_HEADER = "Наименование"
AMOUNT_HEADER = "Сумма"
TOTAL_LABEL = "Всего к оплате:"

# Подписи видов позиции. Набор тот же, что у `INVOICE_ITEM_KINDS`: вид вне
# словаря печатается как есть, а не выпадает из документа.
SUBJECT_LABELS = {
    TARIFF_ITEM_KIND: "Тариф",
    SOLUTION_ITEM_KIND: "Решение",
    SEATS_ITEM_KIND: "Дополнительные места",
}

# Пустое название позиции показывается прочерком: пустая ячейка читается как
# пропуск строки, а не как «названия нет».
EMPTY_VALUE = "—"

# Дата в печатной форме — день месяца словами не нужен, но год обязателен.
DATE_FORMAT = "%d.%m.%Y"

# Геометрия страницы в миллиметрах: A4, поля по 15.
PAGE_MARGIN = 15.0

# Высоты строк по видам текста. Знак занимает свою строку, поэтому заголовок
# получает отдельную высоту, а не делит полосу со знаком.
LINE_HEIGHT = 5.0
TITLE_HEIGHT = 9.0
ROW_PADDING = 1.7
CELL_PADDING = 2.0

# Отбивки между блоками документа.
LOGO_GAP = 5.0
TITLE_GAP = 8.0
PARTIES_GAP = 10.0
TABLE_GAP = 8.0
TOTAL_GAP = 3.0
SIGNATURE_GAP = 8.0
BANK_GAP = 4.0

# Кегли. Крупный — только заголовок и итог: остальное читается как текст.
TITLE_SIZE = 15
LABEL_SIZE = 8
PARTY_NAME_SIZE = 9
PARTY_DETAIL_SIZE = 9
TABLE_SIZE = 9.5
TOTAL_SIZE = 12
WORDS_SIZE = 10
SIGNATORY_SIZE = 10
BANK_SIZE = 9

# Знак сервиса: 11 мм в левом верхнем углу на собственной строке. Высота —
# единственный размер, который читается: `fpdf2` держит пропорции SVG сам, а
# ширина знака нигде не нужна.
LOGO_HEIGHT = 11.0

# Колонки таблицы позиций: номер, наименование (остаток ширины), сумма.
NUMBER_WIDTH = 15.0
AMOUNT_WIDTH = 40.0

# Колонки блоков «Исполнитель» и «Заказчик»: две половины ширины страницы.
PARTY_COLUMN_GAP = 10.0

# Цвета. Таблица набрана тонкими светло-серыми линиями, а подписи блоков —
# серым: они служебные, и чёрный цвет делал бы их равными реквизитам.
HEADER_FILL = (244, 244, 244)
BORDER_COLOR = (200, 200, 200)
LABEL_COLOR = (120, 120, 120)
BLACK = (0, 0, 0)
BORDER_WIDTH = 0.2

# Склейка подряд идущих дефисов в ASCII-запасном имени файла: кириллица из
# «invoice-СЧ-2026-1.pdf» выпадает и оставляет «invoice--2026-1.pdf».
REPEATED_DASHES = re.compile(r"-{2,}")

# Выключка. В таблице все колонки выровнены влево, как в образце счёта; итог
# прижат к правому полю, потому что это сумма к оплате.
ALIGN_LEFT: Literal["L"] = "L"
ALIGN_CENTER: Literal["C"] = "C"
ALIGN_RIGHT: Literal["R"] = "R"


def _filled(value: str | None) -> bool:
    """Заполнено ли значение: пустая строка и пробелы — это «не заполнено»."""
    return bool((value or "").strip())


def _value(value: str | None) -> str:
    """Значение или прочерк: пустая ячейка таблицы читается как пропуск."""
    text = (value or "").strip()
    return text or EMPTY_VALUE


def _date(value: datetime | None) -> str:
    """Дата печатной формы. Наивные даты из SQLite считаются UTC."""
    if value is None:
        return EMPTY_VALUE
    moment = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return moment.strftime(DATE_FORMAT)


def _money(amount: Decimal, currency: str) -> str:
    """Сумма позиции: «1 350 ₽»."""
    symbol = CURRENCY_SYMBOLS.get(currency, currency)
    return f"{format_amount(amount)} {symbol}"


def _text(
    pdf: FPDF,
    text: str,
    *,
    size: float,
    bold: bool = False,
    align: Literal["L", "C", "R"] = ALIGN_LEFT,
    color: tuple[int, int, int] = BLACK,
    width: float | None = None,
    x: float | None = None,
    height: float = LINE_HEIGHT,
) -> None:
    """Строка документа на всю доступную ширину или в свою колонку.

    Курсор уходит к левому полю и вниз: каждый следующий абзац печатается со
    своего `x`, поэтому вертикаль колонки задаёт вызывающий код.
    """
    pdf.set_font(FONT_FAMILY, "B" if bold else "", size)
    pdf.set_text_color(*color)
    if x is not None:
        pdf.set_x(x)
    pdf.multi_cell(
        width if width is not None else 0,
        height,
        text,
        align=align,
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )
    pdf.set_text_color(*BLACK)


def _register_fonts(pdf: FPDF) -> None:
    """Встроить шрифт с кириллицей и знаком рубля.

    В core-шрифтах PDF кириллицы нет: подстановка Helvetica прошла бы молча и
    дала бы пустые квадраты вместо текста. Поэтому отсутствие файла — это отказ
    с внятным текстом, а не запасной шрифт.
    """
    missing = [path for path in (FONT_REGULAR, FONT_BOLD) if not Path(path).is_file()]
    if missing:
        raise RuntimeError(
            "Не найден шрифт для PDF-форм счёта и акта: "
            + ", ".join(missing)
            + ". Установите пакет fonts-dejavu-core в образ API "
            "(app/backend/Dockerfile): без него кириллица в PDF не отрисуется."
        )
    pdf.add_font(FONT_FAMILY, "", FONT_REGULAR)
    pdf.add_font(FONT_FAMILY, "B", FONT_BOLD)


def _draw_logo(pdf: FPDF) -> None:
    """Знак сервиса отдельной строкой в шапке.

    Отсутствие файла — отказ с внятным текстом, а не PDF без знака: молчаливая
    потеря знака незаметна, а ассет лежит в образе и не зависит от настроек.
    """
    if not LOGO_PATH.is_file():
        raise RuntimeError(
            "Не найден знак сервиса для PDF-форм счёта и акта: "
            f"{LOGO_PATH}. Ассет лежит в app/backend/app/assets/logo.svg и попадает "
            "в образ API вместе с `COPY app ./app`; без него шапка документа "
            "осталась бы без знака."
        )
    pdf.image(str(LOGO_PATH), x=pdf.l_margin, y=pdf.get_y(), h=LOGO_HEIGHT)


def _header(pdf: FPDF, heading: str) -> None:
    """Шапка документа: знак на своей строке, заголовок — под ним по центру.

    Знак и заголовок не делят строку: знак — эмблема сервиса, а заголовок
    первичного документа читается по центру полосы набора. Дата входит в
    заголовок («… от 06.11.2026»), отдельной строки у неё нет — так в образце.
    """
    top = pdf.get_y()
    _draw_logo(pdf)
    pdf.set_y(top + LOGO_HEIGHT + LOGO_GAP)
    _text(pdf, heading, size=TITLE_SIZE, bold=True, align=ALIGN_CENTER, height=TITLE_HEIGHT)
    pdf.ln(TITLE_GAP)


def _tax_ids(inn: str | None, kpp: str | None) -> str:
    """«ИНН 7701234567 · КПП 770101001» из заполненных частей.

    Пустая часть выпадает вместе с подписью: «КПП» без номера — это подпись
    реквизита, которого нет.
    """
    values = {"inn": inn, "kpp": kpp}
    parts = [
        f"{label} {(values[field] or '').strip()}"
        for field, label in TAX_ROWS
        if _filled(values[field])
    ]
    return " · ".join(parts)


def _requisite_lines(
    name: str | None,
    inn: str | None,
    kpp: str | None,
    ogrn: str | None,
    address: str | None,
) -> tuple[str, list[str]]:
    """Название стороны и строки её реквизитов: ИНН · КПП, ОГРН, адрес.

    Блоки исполнителя и заказчика различаются только источником данных
    (`CompanyDetails` против снимка `Invoice`), поэтому строки собираются в одном
    месте. Иначе следующая правка образца поправила бы одну сторону и молча
    потеряла поле у другой: тест блоки между собой не сравнивает.
    """
    details: list[str] = []
    tax_ids = _tax_ids(inn, kpp)
    if tax_ids:
        details.append(tax_ids)
    if _filled(ogrn):
        details.append(f"ОГРН {(ogrn or '').strip()}")
    if _filled(address):
        details.append((address or "").strip())
    return (name or "").strip(), details


def _party_lines(company: CompanyDetails | None) -> tuple[str, list[str]]:
    """Название и строки реквизитов исполнителя из таблицы реквизитов.

    Пустые поля не печатаются совсем: «ИНН» без номера и прочерк вместо банка
    выглядели бы как реквизит, которого нет. Когда не заполнено ни одного —
    строки реквизитов заменяет одна честная заглушка; заполненное название при
    пустых остальных реквизитах заглушкой не заменяется, иначе документ
    потерял бы имя исполнителя.
    """
    if company is None or not any(_filled(getattr(company, field)) for field in REQUISITE_FIELDS):
        return "", [SUPPLIER_PLACEHOLDER]
    return _requisite_lines(company.name, company.inn, company.kpp, company.ogrn, company.address)


def _customer_lines(invoice: Invoice) -> tuple[str, list[str]]:
    """Название и строки реквизитов заказчика из снимка счёта."""
    return _requisite_lines(
        invoice.buyer_name,
        invoice.buyer_inn,
        invoice.buyer_kpp,
        invoice.buyer_ogrn,
        invoice.buyer_address,
    )


def _party_block(
    pdf: FPDF, x: float, width: float, heading: str, name: str, details: list[str]
) -> float:
    """Один блок реквизитов в своей колонке. Возвращает нижнюю границу блока."""
    _text(pdf, heading, size=LABEL_SIZE, color=LABEL_COLOR, x=x, width=width)
    if name:
        _text(pdf, name, size=PARTY_NAME_SIZE, bold=True, x=x, width=width)
    for detail in details:
        _text(pdf, detail, size=PARTY_DETAIL_SIZE, x=x, width=width)
    return pdf.get_y()


def _parties(pdf: FPDF, invoice: Invoice, company: CompanyDetails | None) -> None:
    """Исполнитель и заказчик двумя колонками на одной горизонтали.

    Колонки начинаются от одной строки, а курсор уходит ниже той из них,
    которая оказалась длиннее: длинный адрес заказчика не должен наезжать на
    таблицу, а короткий блок исполнителя — тянуть за собой пустоту.
    """
    top = pdf.get_y()
    width = (pdf.epw - PARTY_COLUMN_GAP) / 2
    left_x = pdf.l_margin
    right_x = left_x + width + PARTY_COLUMN_GAP

    executor_name, executor_details = _party_lines(company)
    customer_name, customer_details = _customer_lines(invoice)

    pdf.set_y(top)
    executor_bottom = _party_block(
        pdf, left_x, width, EXECUTOR_HEADING, executor_name, executor_details
    )
    pdf.set_y(top)
    customer_bottom = _party_block(
        pdf, right_x, width, CUSTOMER_HEADING, customer_name, customer_details
    )
    pdf.set_y(max(executor_bottom, customer_bottom))


def _item_cells(item: InvoiceItem, currency: str) -> tuple[str, str]:
    """Наименование и сумма позиции — две ячейки одной строки таблицы.

    В наименование входит то, за что заплатили: вид предмета, название снимка и
    период. У мест рядом с суммой стоит цена места и множитель — иначе сверить
    платёж с числом мест бухгалтерия клиента не смогла бы, а скидка ступени
    осталась бы невидимой.
    """
    label = SUBJECT_LABELS.get(item.kind, item.kind)
    amount = _money(item.amount, currency)
    if item.kind == SEATS_ITEM_KIND:
        quantity = item.quantity or 0
        unit = item.unit_amount if item.unit_amount is not None else item.amount
        name = f"{label} · {quantity} ({_money(unit, currency)} × {quantity})"
        return name, amount
    name = f"{label} «{_value(item.name)}»"
    if item.period:
        name = f"{name} {PERIOD_SUFFIXES.get(item.period, item.period)}"
    return name, amount


def _table_cell(
    pdf: FPDF,
    x: float,
    top: float,
    width: float,
    height: float,
    text: str,
    *,
    bold: bool = False,
    fill: tuple[int, int, int] | None = None,
) -> None:
    """Ячейка таблицы: рамка, при необходимости заливка, текст с внутренним полем."""
    pdf.set_draw_color(*BORDER_COLOR)
    pdf.set_line_width(BORDER_WIDTH)
    if fill is not None:
        pdf.set_fill_color(*fill)
        pdf.rect(x, top, width, height, style="DF")
    else:
        pdf.rect(x, top, width, height, style="D")
    pdf.set_font(FONT_FAMILY, "B" if bold else "", TABLE_SIZE)
    pdf.set_text_color(*BLACK)
    pdf.set_xy(x + CELL_PADDING, top + ROW_PADDING)
    pdf.multi_cell(
        width - 2 * CELL_PADDING,
        LINE_HEIGHT,
        text,
        align=ALIGN_LEFT,
        new_x=XPos.RIGHT,
        new_y=YPos.TOP,
    )


def _cell_lines(pdf: FPDF, width: float, text: str) -> int:
    """Сколько строк займёт текст в ячейке такой ширины.

    `multi_cell` с `dry_run` возвращает раскладку строк, но в типах `fpdf2`
    рядом с ней стоят и числовые режимы, поэтому проверка `isinstance` — не
    перестраховка: без неё `len` типизирован как «не всякий вариант».
    """
    wrapped = pdf.multi_cell(
        width - 2 * CELL_PADDING,
        LINE_HEIGHT,
        text,
        dry_run=True,
        output="LINES",
    )
    return len(wrapped) if isinstance(wrapped, list) else 1


def _table_row(
    pdf: FPDF,
    widths: tuple[float, float, float],
    cells: tuple[str, str, str],
    *,
    bold: bool = False,
    fill: tuple[int, int, int] | None = None,
) -> None:
    """Строка таблицы: высота по самой высокой ячейке, чтобы текст не вылезал.

    Значение в ячейке переносится по словам, поэтому высоту строки нельзя взять
    константой: длинное наименование у тарифа и короткое «Дополнительные места»
    помещаются в разное число строк.
    """
    pdf.set_font(FONT_FAMILY, "B" if bold else "", TABLE_SIZE)
    lines = [_cell_lines(pdf, width, text) for text, width in zip(cells, widths, strict=True)]
    height = max(lines) * LINE_HEIGHT + 2 * ROW_PADDING
    top = pdf.get_y()
    x = pdf.l_margin
    for text, width in zip(cells, widths, strict=True):
        _table_cell(pdf, x, top, width, height, text, bold=bold, fill=fill)
        x += width
    pdf.set_y(top + height)


def _column_widths(pdf: FPDF) -> tuple[float, float, float]:
    """Ширины колонок таблицы позиций: номер, наименование, сумма.

    Наименование забирает остаток полосы набора, поэтому сумма колонок равна
    `epw` без остатка: подобранная на глаз правая граница вышла бы за поле или
    оставила пустую полосу. Расчёт живёт отдельной функцией, чтобы его звала и
    таблица, и тест геометрии — иначе тест проверял бы сам себя.
    """
    return (
        NUMBER_WIDTH,
        pdf.epw - NUMBER_WIDTH - AMOUNT_WIDTH,
        AMOUNT_WIDTH,
    )


def _subject_table(pdf: FPDF, invoice: Invoice) -> None:
    """Таблица предмета счёта: номер, наименование, сумма по каждой позиции.

    Позиции берутся из `invoice_items`: у покупки «тариф + места» их две, и
    документ печатает обе. Счёт без позиций (выставленный до ревизии
    `0066_invoice_items`) читается по своему снимку одной позицией — форма
    прежних счетов остаётся той же.
    """
    widths = _column_widths(pdf)
    _table_row(
        pdf,
        widths,
        (NUMBER_HEADER, NAME_HEADER, AMOUNT_HEADER),
        bold=True,
        fill=HEADER_FILL,
    )
    for index, item in enumerate(subject_items(invoice), start=1):
        name, amount = _item_cells(item, invoice.currency)
        _table_row(pdf, widths, (str(index), name, amount))


def _vat_note(company: CompanyDetails | None) -> str:
    """Строка про НДС: `vat_note` из реквизитов или пустая строка — «нет строки»."""
    if company is None:
        return ""
    return (company.vat_note or "").strip()


def _totals(pdf: FPDF, invoice: Invoice, company: CompanyDetails | None) -> None:
    """Итог счёта, сумма прописью и строка про НДС — в этом порядке.

    Сумма прописью стоит сразу под итогом цифрами: так её сверяет бухгалтерия
    клиента, и так она стоит в образце первичного документа.
    """
    pdf.ln(TOTAL_GAP)
    _text(
        pdf,
        f"{TOTAL_LABEL} {_money(invoice.amount, invoice.currency)}",
        size=TOTAL_SIZE,
        bold=True,
        align=ALIGN_RIGHT,
    )
    pdf.ln(TOTAL_GAP)
    _text(pdf, amount_in_words(invoice.amount, invoice.currency), size=WORDS_SIZE)
    note = _vat_note(company)
    if note:
        _text(pdf, note, size=WORDS_SIZE)


def _signature(pdf: FPDF, company: CompanyDetails | None) -> None:
    """Подпись исполнителя: подпись раздела и имя подписанта.

    Пустой подписант — это отсутствующий раздел, а не «ИСПОЛНИТЕЛЬ» без имени:
    подпись раздела без подписи ничего не сообщает, а блок исполнителя выше уже
    сказал, что реквизиты не заведены.
    """
    if company is None or not _filled(company.signatory):
        return
    pdf.ln(SIGNATURE_GAP)
    _text(pdf, EXECUTOR_HEADING, size=LABEL_SIZE, color=LABEL_COLOR)
    _text(pdf, (company.signatory or "").strip(), size=SIGNATORY_SIZE)


def _bank_details(pdf: FPDF, company: CompanyDetails | None) -> None:
    """Банковские реквизиты исполнителя: только заполненные строки."""
    if company is None:
        return
    rows = [
        (label, (getattr(company, field) or "").strip())
        for label, field in BANK_ROWS
        if _filled(getattr(company, field))
    ]
    if not rows:
        return
    pdf.ln(BANK_GAP)
    _text(pdf, BANK_HEADING, size=BANK_SIZE, bold=True)
    for label, value in rows:
        _text(pdf, f"{label}: {value}", size=BANK_SIZE)


def _document(
    heading: str,
    invoice: Invoice,
    company: CompanyDetails | None,
) -> bytes:
    """Общая обвязка печатной формы: счёт и акт отличаются заголовком."""
    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_margins(PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN)
    pdf.set_auto_page_break(auto=True, margin=PAGE_MARGIN)
    _register_fonts(pdf)
    # Заголовок уходит и в метаданные файла: так документ подписан в просмотрщике.
    pdf.set_title(heading)
    pdf.add_page()

    _header(pdf, heading)
    _parties(pdf, invoice, company)
    pdf.ln(TABLE_GAP)
    _subject_table(pdf, invoice)
    _totals(pdf, invoice, company)
    _signature(pdf, company)
    _bank_details(pdf, company)

    return bytes(pdf.output())


def invoice_pdf(invoice: Invoice, company: CompanyDetails | None) -> bytes:
    """Печатная форма счёта: доступна с момента выставления.

    `company` — реквизиты поставщика из `app/company_details.py` или `None`.
    Модуль базу не читает: строку передаёт вызывающий код (`app/invoice_files.py`),
    поэтому форма проверяется тестом без сессии.
    """
    return _document(
        heading=f"Счёт на оплату № {invoice.number} от {_date(invoice.created_at)}",
        invoice=invoice,
        company=company,
    )


def act_pdf(invoice: Invoice, company: CompanyDetails | None) -> bytes:
    """Печатная форма акта: появляется после оплаты счёта.

    Блок исполнителя и строка про НДС — те же, что у счёта: налоговый режим и
    поставщик у акта не свои, а общие. Дата акта — день оплаты.
    """
    return _document(
        heading=f"Акт № {invoice.number} от {_date(invoice.paid_at)}",
        invoice=invoice,
        company=company,
    )


def content_disposition(filename: str) -> str:
    """Заголовок скачивания с ASCII-запасным именем файла.

    Кириллицу (`СЧ`) в значение заголовка положить нельзя: HTTP-заголовки
    кодируются latin-1, и такой ответ падает ещё до отправки. Поэтому имя
    дублируется по RFC 5987 (`filename*=UTF-8''…`), а в `filename=` остаётся
    ASCII-вариант того же имени — его понимают старые клиенты.
    """
    ascii_name = REPEATED_DASHES.sub("-", filename.encode("ascii", "ignore").decode("ascii"))
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename, safe='')}"
