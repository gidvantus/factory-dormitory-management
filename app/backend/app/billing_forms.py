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

**Поставщик и НДС (#179).** Реквизиты поставщика и строку про НДС приносит
вызывающий код — готовая строка `CompanyDetails` или `None`. Модуль по-прежнему
не читает базу: строку ему передаёт `app/invoice_files.py` через
`app/company_details.py`, поэтому форму можно проверять тестом без сессии.

* Блок «Поставщик» печатает только заполненные поля и в фиксированном порядке.
  Не заполнено ни одного (или `company is None`) — печатается прежняя заглушка
  одним абзацем: прочерки вместо названия и банка выглядели бы как реквизиты,
  которых нет. `_value` для этого блока поэтому не применяется.
* Ширина колонки подписей считается по метрикам шрифта, а не берётся константой:
  «Корреспондентский счёт» шире 45 мм, и в фиксированной колонке значение
  печаталось поверх подписи.
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

from app.models.company_details import CompanyDetails
from app.models.invoice import (
    SEATS_ITEM_KIND,
    SOLUTION_ITEM_KIND,
    TARIFF_ITEM_KIND,
    Invoice,
    InvoiceItem,
    subject_items,
)
from app.pricing import CURRENCY_SYMBOLS, format_amount, format_invoice_amount

# Семейство и файлы шрифта. Путь — из пакета образа: бинарники в git не кладём.
FONT_FAMILY = "DejaVu"
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# Знак сервиса: SVG рядом с модулем. В образ попадает существующим `COPY app ./app`
# (`app/backend/Dockerfile`), отдельного тома и настройки у него нет намеренно:
# знак — часть формы, а не данные. `fpdf2` рисует SVG сам, бинарник не нужен.
LOGO_PATH = Path(__file__).parent / "assets" / "logo.svg"

# Заглушка блока поставщика: печатается, пока не заполнено ни одного реквизита.
SUPPLIER_PLACEHOLDER = "данные поставщика будут заполнены позже"

# Подпись раздела поставщика.
SUPPLIER_HEADING = "Поставщик"

# Поля блока «Поставщик» и их подписи — в том порядке, в каком они печатаются.
# Поле модели названо строкой, а не значением: блок собирается из `CompanyDetails`,
# и порядок строк — часть вида документа.
SUPPLIER_ROWS = (
    ("Название", "name"),
    ("ИНН", "inn"),
    ("КПП", "kpp"),
    ("ОГРН", "ogrn"),
    ("Адрес", "address"),
    ("Банк", "bank_name"),
    ("БИК", "bank_bic"),
    ("Расчётный счёт", "bank_account"),
    ("Корреспондентский счёт", "corr_account"),
    ("Подписант", "signatory"),
)

# Пустое значение показывается прочерком, а не пустой ячейкой: у индивидуального
# предпринимателя КПП отсутствует, и это нормальное состояние счёта.
EMPTY_VALUE = "—"

# Дата в печатной форме — день месяца словами не нужен, но год обязателен.
DATE_FORMAT = "%d.%m.%Y"

# Геометрия страницы в миллиметрах: A4, поля по 15, подпись — не уже 45,
# значение — остаток ширины. Колонка подписей не константа: она считается по
# метрикам шрифта (`_label_width`), потому что «Корреспондентский счёт» шире 45 мм
# и, напечатанный `cell` в 45 мм, наезжал на номер счёта. 45 — нижняя граница,
# чтобы короткие блоки («Покупатель») не съеживались.
PAGE_MARGIN = 15.0
LABEL_WIDTH = 45.0
# Отступ между подписью и значением: половина уходит на внутренние поля ячейки.
LABEL_GAP = 4.0
# Минимум, который остаётся значению: длинная подпись не съедает весь ряд.
MIN_VALUE_WIDTH = 60.0
LINE_HEIGHT = 6.0
TITLE_HEIGHT = 9.0
SECTION_GAP = 5.0
TITLE_SIZE = 16
HEADING_SIZE = 13
BODY_SIZE = 11

# Знак сервиса в шапке: высота 11 мм в левом верхнем углу, заголовок — справа от
# него на той же линии. Знак квадратный (40×40 во viewBox), поэтому ширина равна
# высоте; отступ между знаком и заголовком — 4 мм.
LOGO_HEIGHT = 11.0
LOGO_WIDTH = LOGO_HEIGHT
LOGO_GAP = 4.0

# Склейка подряд идущих дефисов в ASCII-запасном имени файла: кириллица из
# «invoice-СЧ-2026-1.pdf» выпадает и оставляет «invoice--2026-1.pdf».
REPEATED_DASHES = re.compile(r"-{2,}")

# Выключка влево, а не по ширине: между словами не появляется лишних пробелов,
# и текст из файла читается так же, как он был записан.
ALIGN_LEFT: Literal["L"] = "L"


# Подпись раздела с предметами счёта и подпись итоговой строки. Итог в документе
# стоит последним: первичный документ обязан показать сумму, которую платят.
SUBJECT_HEADING = "Предмет"
TOTAL_LABEL = "Итого"

# Подписи видов позиции. Набор тот же, что у `INVOICE_ITEM_KINDS`: вид вне
# словаря печатается как есть, а не выпадает из документа.
SUBJECT_LABELS = {
    TARIFF_ITEM_KIND: "Тариф",
    SOLUTION_ITEM_KIND: "Решение",
    SEATS_ITEM_KIND: "Дополнительные места",
}


def _value(value: str | None) -> str:
    """Значение или прочерк: пустая ячейка читается как пропуск."""
    text = (value or "").strip()
    return text or EMPTY_VALUE


def _date(value: datetime | None) -> str:
    """Дата печатной формы. Наивные даты из SQLite считаются UTC."""
    if value is None:
        return EMPTY_VALUE
    moment = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return moment.strftime(DATE_FORMAT)


def _amount_label(invoice: Invoice) -> str:
    """Сумма счёта: подпись собирает `app/pricing`, а не печатная форма."""
    return format_invoice_amount(invoice.amount, invoice.currency, invoice.tariff_period)


def _buyer_rows(invoice: Invoice) -> list[tuple[str, str | None]]:
    """Реквизиты покупателя из снимка счёта."""
    return [
        ("Название", invoice.buyer_name),
        ("ИНН", invoice.buyer_inn),
        ("КПП", invoice.buyer_kpp),
        ("ОГРН", invoice.buyer_ogrn),
        ("Адрес", invoice.buyer_address),
    ]


def _money(amount: Decimal, currency: str) -> str:
    """Сумма позиции без окончания по периоду: «1 350 ₽»."""
    symbol = CURRENCY_SYMBOLS.get(currency, currency)
    return f"{format_amount(amount)} {symbol}"


def _subject_line(item: InvoiceItem, currency: str) -> str:
    """Строка позиции в том виде, в каком она читается в документе.

    У тарифа и решения период входит в подпись («60 000 ₽ за 6 месяцев»), у мест
    рядом с суммой стоит цена места и множитель — «7 500 ₽ (1 500 ₽ × 5)»: иначе
    сверить платёж с числом мест бухгалтерия клиента не смогла бы, а скидка
    ступени осталась бы невидимой.
    """
    label = SUBJECT_LABELS.get(item.kind, item.kind)
    if item.kind == SEATS_ITEM_KIND:
        quantity = item.quantity or 0
        unit = item.unit_amount if item.unit_amount is not None else item.amount
        return (
            f"{label} · {quantity} — {_money(item.amount, currency)} "
            f"({_money(unit, currency)} × {quantity})"
        )
    amount_label = format_invoice_amount(item.amount, currency, item.period)
    return f"{label} «{_value(item.name)}» — {amount_label}"


def _subject_lines(invoice: Invoice) -> list[str]:
    """Предмет счёта: по строке на позицию и итог последней.

    Позиции берутся из `invoice_items`: у покупки «тариф + места» их две, и
    документ печатает обе. Счёт без позиций (выставленный до ревизии
    `0066_invoice_items`) читается по своему снимку одной позицией — форма
    прежних счетов остаётся той же.
    """
    lines = [_subject_line(item, invoice.currency) for item in subject_items(invoice)]
    lines.append(f"{TOTAL_LABEL}: {_amount_label(invoice)}")
    return lines


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


def _paragraph(pdf: FPDF, text: str) -> None:
    """Абзац на всю ширину. Курсор возвращается к левому полю и идёт вниз."""
    pdf.set_x(pdf.l_margin)
    pdf.multi_cell(
        pdf.epw,
        LINE_HEIGHT,
        text,
        align=ALIGN_LEFT,
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )


def _heading(pdf: FPDF, text: str) -> None:
    """Заголовок раздела: отбивается пустой строкой и возвращает обычный шрифт."""
    pdf.ln(SECTION_GAP)
    pdf.set_font(FONT_FAMILY, "B", HEADING_SIZE)
    _paragraph(pdf, text)
    pdf.set_font(FONT_FAMILY, "", BODY_SIZE)


def _filled(value: str | None) -> bool:
    """Заполнено ли значение: пустая строка и пробелы — это «не заполнено»."""
    return bool((value or "").strip())


def _supplier_rows(company: CompanyDetails | None) -> list[tuple[str, str]]:
    """Заполненные реквизиты поставщика в порядке печати.

    Пустые поля не печатаются вовсе, а не прочерком: строка «Название —» ничего
    не сообщает, а «данные поставщика будут заполнены позже» говорит правду.
    Поэтому здесь не применяется `_value`: блок поставщика прочерками не
    добивается.
    """
    if company is None:
        return []
    rows: list[tuple[str, str]] = []
    for label, field in SUPPLIER_ROWS:
        value: str | None = getattr(company, field)
        if _filled(value):
            rows.append((label, (value or "").strip()))
    return rows


def _vat_note(company: CompanyDetails | None) -> str:
    """Строка про НДС: `vat_note` из реквизитов или пустая строка — «нет строки»."""
    if company is None:
        return ""
    return (company.vat_note or "").strip()


def _draw_logo(pdf: FPDF) -> None:
    """Знак сервиса в левом верхнем углу шапки.

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


def _label_width(pdf: FPDF, labels: list[str]) -> float:
    """Ширина колонки подписей по самой длинной из них.

    Подписи печатаются тем же жирным шрифтом, что и в документе, поэтому ширину
    даёт `get_string_width`, а не константа: «Корреспондентский счёт» занимает
    56,63 мм при 45, и `cell(45, …)` печатал его без переноса — номер счёта
    рисовался поверх слова «счёт» (замечание Б1). Ниже `LABEL_WIDTH` колонка не
    опускается, чтобы короткие блоки не съеживались, а справа всегда остаётся
    `MIN_VALUE_WIDTH` — иначе длинная подпись съела бы место значения. Шрифт
    после замера возвращается к обычному: следующий за блоком абзац (заглушка или
    строка про НДС) печатается не жирным.
    """
    if not labels:
        return LABEL_WIDTH
    pdf.set_font(FONT_FAMILY, "B", BODY_SIZE)
    widest = max(pdf.get_string_width(label) for label in labels)
    # Шрифт замера — не шрифт документа: следующий абзац печатается обычным.
    pdf.set_font(FONT_FAMILY, "", BODY_SIZE)
    return min(max(LABEL_WIDTH, widest + LABEL_GAP), pdf.epw - MIN_VALUE_WIDTH)


def _row(
    pdf: FPDF,
    label: str,
    value: str | None,
    label_width: float = LABEL_WIDTH,
) -> None:
    """Подпись слева, значение справа: длинное значение переносится целиком.

    `label_width` приходит из `_label_width`: у блока поставщика он шире 45 мм,
    иначе длинная подпись наезжает на значение. Подпись тоже печатается
    `multi_cell` — если она не влезла в отведённую колонку, она переносится на
    вторую строку, а не рисуется поверх значения; курсор уходит ниже той из двух
    колонок, которая оказалась длиннее.
    """
    x = pdf.l_margin
    y = pdf.get_y()
    pdf.set_font(FONT_FAMILY, "B", BODY_SIZE)
    pdf.set_xy(x, y)
    pdf.multi_cell(
        label_width,
        LINE_HEIGHT,
        label,
        align=ALIGN_LEFT,
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )
    label_bottom = pdf.get_y()
    pdf.set_font(FONT_FAMILY, "", BODY_SIZE)
    pdf.set_xy(x + label_width, y)
    pdf.multi_cell(
        pdf.epw - label_width,
        LINE_HEIGHT,
        _value(value),
        align=ALIGN_LEFT,
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )
    if pdf.get_y() < label_bottom:
        pdf.set_y(label_bottom)


def _header(pdf: FPDF, heading: str, date: datetime | None) -> None:
    """Шапка документа: знак слева, заголовок справа от него, дата под заголовком.

    Заголовок и дата выровнены по одной вертикали справа от знака: знак выше
    строки заголовка, и дата не должна «подныривать» под него. `multi_cell`
    возвращает курсор к левому полю, поэтому `x` заголовка выставляется явно
    перед датой.
    """
    top = pdf.get_y()
    _draw_logo(pdf)
    title_x = pdf.l_margin + LOGO_WIDTH + LOGO_GAP
    title_width = pdf.epw - LOGO_WIDTH - LOGO_GAP
    pdf.set_font(FONT_FAMILY, "B", TITLE_SIZE)
    pdf.set_xy(title_x, top)
    pdf.multi_cell(
        title_width,
        TITLE_HEIGHT,
        heading,
        align=ALIGN_LEFT,
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )
    pdf.set_font(FONT_FAMILY, "", BODY_SIZE)
    # Дата идёт под заголовком, но не выше нижней кромки знака: иначе у
    # трёхстрочного заголовка она наезжала бы на знак.
    pdf.set_xy(title_x, max(pdf.get_y(), top + LOGO_HEIGHT))
    pdf.multi_cell(
        title_width,
        LINE_HEIGHT,
        f"Дата: {_date(date)}",
        align=ALIGN_LEFT,
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )


def _document(
    heading: str,
    invoice: Invoice,
    date: datetime | None,
    company: CompanyDetails | None,
) -> bytes:
    """Общая обвязка печатной формы: счёт и акт отличаются заголовком и датой."""
    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_margins(PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN)
    pdf.set_auto_page_break(auto=True, margin=PAGE_MARGIN)
    _register_fonts(pdf)
    # Заголовок уходит и в метаданные файла: так документ подписан в просмотрщике.
    pdf.set_title(heading)
    pdf.add_page()

    _header(pdf, heading, date)

    _heading(pdf, SUPPLIER_HEADING)
    rows = _supplier_rows(company)
    # Колонка подписей одна на оба блока: значения в «Поставщике» и «Покупателе»
    # стоят на одной вертикали, и «Корреспондентский счёт» не выводит её из 45 мм.
    buyer_rows = _buyer_rows(invoice)
    label_width = _label_width(
        pdf,
        [label for label, _ in rows] + [label for label, _ in buyer_rows],
    )
    if rows:
        for label, text in rows:
            _row(pdf, label, text, label_width)
    else:
        # Ни одного заполненного реквизита — честная заглушка одним абзацем.
        _paragraph(pdf, SUPPLIER_PLACEHOLDER)

    _heading(pdf, "Покупатель")
    for label, value in buyer_rows:
        _row(pdf, label, value, label_width)

    _heading(pdf, SUBJECT_HEADING)
    for line in _subject_lines(invoice):
        _paragraph(pdf, line)

    # Строка про НДС — сразу после «Предмета», в обеих формах одна и та же.
    note = _vat_note(company)
    if note:
        _paragraph(pdf, note)

    return bytes(pdf.output())


def invoice_pdf(invoice: Invoice, company: CompanyDetails | None) -> bytes:
    """Печатная форма счёта: доступна с момента выставления.

    `company` — реквизиты поставщика из `app/company_details.py` или `None`.
    Модуль базу не читает: строку передаёт вызывающий код (`app/invoice_files.py`),
    поэтому форма проверяется тестом без сессии.
    """
    return _document(
        heading=f"Счёт № {invoice.number}",
        invoice=invoice,
        date=invoice.created_at,
        company=company,
    )


def act_pdf(invoice: Invoice, company: CompanyDetails | None) -> bytes:
    """Печатная форма акта: появляется после оплаты счёта.

    Блок поставщика и строка про НДС — те же, что у счёта: налоговый режим и
    поставщик у акта не свои, а общие.
    """
    return _document(
        heading=f"Акт № {invoice.number}",
        invoice=invoice,
        date=invoice.paid_at,
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
