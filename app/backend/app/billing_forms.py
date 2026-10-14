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
показывает то, что было в момент покупки. Блок поставщика пуст и подписан
заглушкой — банковских реквизитов в проекте нет, а выдумывать их нельзя.

Модуль ничего не читает из базы и ничего не пишет на диск: на вход идут готовые
поля счёта, а наружу — готовые байты, поэтому его можно проверять тестом без
HTTP, без сессии и без файловой системы.
"""

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fpdf import FPDF
from fpdf.enums import XPos, YPos

from app.models.invoice import Invoice
from app.pricing import format_invoice_amount

# Семейство и файлы шрифта. Путь — из пакета образа: бинарники в git не кладём.
FONT_FAMILY = "DejaVu"
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# Заглушка блока поставщика: реквизитов поставщика в проекте нет вовсе.
SUPPLIER_PLACEHOLDER = "данные поставщика будут заполнены позже"

# Пустое значение показывается прочерком, а не пустой ячейкой: у индивидуального
# предпринимателя КПП отсутствует, и это нормальное состояние счёта.
EMPTY_VALUE = "—"

# Дата в печатной форме — день месяца словами не нужен, но год обязателен.
DATE_FORMAT = "%d.%m.%Y"

# Геометрия страницы в миллиметрах: A4, поля по 15, подпись 45, значение —
# остаток ширины. Содержимое формы умещается в одну страницу с большим запасом,
# а автоматический перенос оставлен как страховка от очень длинного адреса.
PAGE_MARGIN = 15.0
LABEL_WIDTH = 45.0
LINE_HEIGHT = 6.0
TITLE_HEIGHT = 9.0
SECTION_GAP = 5.0
TITLE_SIZE = 16
HEADING_SIZE = 13
BODY_SIZE = 11

# Склейка подряд идущих дефисов в ASCII-запасном имени файла: кириллица из
# «invoice-СЧ-2026-1.pdf» выпадает и оставляет «invoice--2026-1.pdf».
REPEATED_DASHES = re.compile(r"-{2,}")

# Выключка влево, а не по ширине: между словами не появляется лишних пробелов,
# и текст из файла читается так же, как он был записан.
ALIGN_LEFT: Literal["L"] = "L"


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


def _subject_rows(invoice: Invoice) -> list[tuple[str, str | None]]:
    """Предмет счёта: что куплено и за какую сумму."""
    return [
        ("Тариф", invoice.tariff_name),
        ("Номер счёта", invoice.number),
        ("Сумма", _amount_label(invoice)),
    ]


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


def _row(pdf: FPDF, label: str, value: str | None) -> None:
    """Подпись слева, значение справа: длинное значение переносится целиком."""
    x = pdf.l_margin
    y = pdf.get_y()
    pdf.set_font(FONT_FAMILY, "B", BODY_SIZE)
    pdf.set_xy(x, y)
    pdf.cell(LABEL_WIDTH, LINE_HEIGHT, label)
    pdf.set_font(FONT_FAMILY, "", BODY_SIZE)
    pdf.set_xy(x + LABEL_WIDTH, y)
    pdf.multi_cell(
        pdf.epw - LABEL_WIDTH,
        LINE_HEIGHT,
        _value(value),
        align=ALIGN_LEFT,
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )


def _document(heading: str, invoice: Invoice, date: datetime | None) -> bytes:
    """Общая обвязка печатной формы: счёт и акт отличаются заголовком и датой."""
    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_margins(PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN)
    pdf.set_auto_page_break(auto=True, margin=PAGE_MARGIN)
    _register_fonts(pdf)
    # Заголовок уходит и в метаданные файла: так документ подписан в просмотрщике.
    pdf.set_title(heading)
    pdf.add_page()

    pdf.set_font(FONT_FAMILY, "B", TITLE_SIZE)
    pdf.set_x(pdf.l_margin)
    pdf.multi_cell(
        pdf.epw,
        TITLE_HEIGHT,
        heading,
        align=ALIGN_LEFT,
        new_x=XPos.LMARGIN,
        new_y=YPos.NEXT,
    )
    pdf.set_font(FONT_FAMILY, "", BODY_SIZE)
    _paragraph(pdf, f"Дата: {_date(date)}")

    _heading(pdf, "Поставщик")
    _paragraph(pdf, SUPPLIER_PLACEHOLDER)

    _heading(pdf, "Покупатель")
    for label, value in _buyer_rows(invoice):
        _row(pdf, label, value)

    _heading(pdf, "Предмет")
    for label, value in _subject_rows(invoice):
        _row(pdf, label, value)

    return bytes(pdf.output())


def invoice_pdf(invoice: Invoice) -> bytes:
    """Печатная форма счёта: доступна с момента выставления."""
    return _document(
        heading=f"Счёт № {invoice.number}",
        invoice=invoice,
        date=invoice.created_at,
    )


def act_pdf(invoice: Invoice) -> bytes:
    """Печатная форма акта: появляется после оплаты счёта."""
    return _document(
        heading=f"Акт № {invoice.number}",
        invoice=invoice,
        date=invoice.paid_at,
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
