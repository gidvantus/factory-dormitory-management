"""Общее представление счёта: подписи, признак акта и PDF-ответ.

Модуль вынесен из `app/api/billing.py` затем, чтобы платформенный контур
кабинета оператора (`app/api/platform_invoices.py`) отдавал счёт **ровно так
же**, как кабинет клиента: набор полей, подписи статуса и суммы, признак акта и
тип файла собираются в одном месте. Вторая копия этого представления в новом
роутере разошлась бы с первой на первой же правке — например, когда у счёта
появился `item_kind` (решения магазина), и кабинет оператора показывал бы
тарифный снимок без вида предмета.

Что здесь **не** живёт:

* правила переходов статуса — `app/invoice_status.py`, единственное место;
* сборка и хранение PDF — `app/billing_forms.py` и `app/invoice_files.py`;
* доступ и разбор пути — каждый роутер держит своё: у кабинета клиента это
  членство в организации, у платформенного контура — сервисный токен.

Поведение ручек кабинета клиента от переноса не меняется: `app/api/billing.py`
импортирует эти функции под своими прежними именами в местах вызова.
"""

from typing import cast

from fastapi import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import billing_forms
from app.invoice_status import ACT_KIND, status_label
from app.models.invoice import Invoice, InvoiceDocument
from app.pricing import format_invoice_amount
from app.schemas.invoice import InvoiceItemKind, InvoiceResponse, InvoiceStatus

# Текст отказа «акта ещё нет» — часть контракта: кабинет передаёт его дословно.
ACT_NOT_FOUND_DETAIL = "Акт по счёту ещё не сформирован"

# Печатные формы счёта и акта отдаются PDF-файлом: форма собирается один раз
# (`app/invoice_files.py`) и дальше отдаётся сохранённое.
PDF_MEDIA_TYPE = "application/pdf"


def act_invoice_ids(db: Session, invoice_ids: list[int]) -> set[int]:
    """Счета, у которых уже есть акт. Одним запросом на весь список."""
    if not invoice_ids:
        return set()
    rows = db.scalars(
        select(InvoiceDocument.invoice_id).where(
            InvoiceDocument.invoice_id.in_(invoice_ids),
            InvoiceDocument.kind == ACT_KIND,
        )
    )
    return set(rows)


def invoice_response(invoice: Invoice, has_act: bool, can_manage: bool) -> InvoiceResponse:
    """Ответ по строке счёта: подписи статуса и суммы собирает сервер."""
    return InvoiceResponse(
        id=invoice.id,
        number=invoice.number,
        # В колонке `VARCHAR(20)` набор значений держит `CHECK` по тем же
        # статусам, что объявляет `InvoiceStatus`; приведение говорит об этом
        # типизатору, а не ослабляет проверку.
        status=cast(InvoiceStatus, invoice.status),
        status_label=status_label(invoice.status),
        # Набор значений держит `CHECK` по тем же видам, что объявляет
        # `InvoiceItemKind`; приведение говорит об этом типизатору.
        item_kind=cast(InvoiceItemKind, invoice.item_kind),
        quantity=invoice.quantity,
        amount=invoice.amount,
        currency=invoice.currency,
        amount_label=format_invoice_amount(invoice.amount, invoice.currency, invoice.tariff_period),
        tariff_name=invoice.tariff_name,
        tariff_period=invoice.tariff_period,
        buyer_name=invoice.buyer_name,
        buyer_inn=invoice.buyer_inn,
        buyer_kpp=invoice.buyer_kpp,
        buyer_ogrn=invoice.buyer_ogrn,
        buyer_address=invoice.buyer_address,
        has_act=has_act,
        can_manage=can_manage,
        paid_at=invoice.paid_at,
        created_at=invoice.created_at,
    )


def pdf_response(content: bytes, filename: str) -> Response:
    """Файл печатной формы вложением: имя дублируется ASCII-запасным."""
    return Response(
        content=content,
        media_type=PDF_MEDIA_TYPE,
        headers={"Content-Disposition": billing_forms.content_disposition(filename)},
    )
