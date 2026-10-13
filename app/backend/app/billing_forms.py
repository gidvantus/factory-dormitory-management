"""Сборка HTML печатных форм счёта и акта.

Формы собираются строкой, без шаблонизатора и без сторонних библиотек: разметка
маленькая и целиком наша, а лишняя зависимость в образе API стоит дороже, чем
двадцать строк форматирования. Каждое значение проходит через `html.escape`:
название организации приходит из DaData и может содержать `<` или `&`, и без
экранирования такая строка ломает разметку.

Данные покупателя берутся из снимка в счёте, а не из карточки организации: счёт
показывает то, что было в момент покупки. Блок поставщика пуст и подписан
заглушкой — банковских реквизитов в проекте нет, а выдумывать их нельзя.

Модуль ничего не читает из базы: на вход идут готовые поля счёта, поэтому его
можно проверять тестом без HTTP и без сессии.
"""

import re
from datetime import UTC, datetime
from html import escape
from urllib.parse import quote

from app.models.invoice import Invoice
from app.pricing import format_invoice_amount

DOCTYPE = "<!DOCTYPE html>"

CHARSET = '<meta charset="utf-8">'

# Заглушка блока поставщика: реквизитов поставщика в проекте нет вовсе.
SUPPLIER_PLACEHOLDER = "данные поставщика будут заполнены позже"

# Пустое значение показывается прочерком, а не пустой ячейкой: у индивидуального
# предпринимателя КПП отсутствует, и это нормальное состояние счёта.
EMPTY_VALUE = "—"

# Дата в печатной форме — день месяца словами не нужен, но год обязателен.
DATE_FORMAT = "%d.%m.%Y"

# Склейка подряд идущих дефисов в ASCII-запасном имени файла: кириллица из
# «invoice-СЧ-2026-1.html» выпадает и оставляет «invoice--2026-1.html».
REPEATED_DASHES = re.compile(r"-{2,}")


def _value(value: str | None) -> str:
    """Экранированное значение или прочерк: пустая ячейка читается как пропуск."""
    text = (value or "").strip()
    return escape(text) if text else EMPTY_VALUE


def _date(value: datetime | None) -> str:
    """Дата печатной формы. Наивные даты из SQLite считаются UTC."""
    if value is None:
        return EMPTY_VALUE
    moment = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return moment.strftime(DATE_FORMAT)


def _row(label: str, value: str | None) -> str:
    return f"<tr><th>{escape(label)}</th><td>{_value(value)}</td></tr>"


def _amount_label(invoice: Invoice) -> str:
    """Сумма счёта: подпись собирает `app/pricing`, а не разметка."""
    return format_invoice_amount(invoice.amount, invoice.currency, invoice.tariff_period)


def _buyer_rows(invoice: Invoice) -> str:
    """Реквизиты покупателя из снимка счёта."""
    rows = [
        _row("Название", invoice.buyer_name),
        _row("ИНН", invoice.buyer_inn),
        _row("КПП", invoice.buyer_kpp),
        _row("ОГРН", invoice.buyer_ogrn),
        _row("Адрес", invoice.buyer_address),
    ]
    return "\n      ".join(rows)


def _subject_rows(invoice: Invoice) -> str:
    """Предмет счёта: что куплено и за какую сумму."""
    rows = [
        _row("Тариф", invoice.tariff_name),
        _row("Номер счёта", invoice.number),
        _row("Сумма", _amount_label(invoice)),
    ]
    return "\n      ".join(rows)


def _page(heading: str, invoice: Invoice, date: datetime | None, marker: str) -> str:
    """Общая обвязка печатной формы: счёт и акт отличаются заголовком и датой."""
    return f"""{DOCTYPE}
<html lang="ru">
  <head>
    {CHARSET}
    <title>{escape(heading)}</title>
  </head>
  <body>
    <h1>{escape(heading)}</h1>
    <p data-document="{escape(marker)}">Дата: {_date(date)}</p>

    <section>
      <h2>Поставщик</h2>
      <p>{escape(SUPPLIER_PLACEHOLDER)}</p>
    </section>

    <section>
      <h2>Покупатель</h2>
      <table>
      {_buyer_rows(invoice)}
      </table>
    </section>

    <section>
      <h2>Предмет</h2>
      <table>
      {_subject_rows(invoice)}
      </table>
    </section>
  </body>
</html>
"""


def invoice_html(invoice: Invoice) -> str:
    """Печатная форма счёта: доступна с момента выставления."""
    return _page(
        heading=f"Счёт № {invoice.number}",
        invoice=invoice,
        date=invoice.created_at,
        marker="invoice",
    )


def act_html(invoice: Invoice) -> str:
    """Печатная форма акта: появляется после оплаты счёта."""
    return _page(
        heading=f"Акт № {invoice.number}",
        invoice=invoice,
        date=invoice.paid_at,
        marker="act",
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
