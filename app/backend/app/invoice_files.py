"""Печатные формы счёта и акта: единственное место, где они ходят в хранилище.

Счёт и акт — PDF, который собирает `app/billing_forms.py`. До этой задачи форма
собиралась на каждый запрос, и два скачивания одного счёта давали разные байты:
fpdf2 пишет в метаданные `/CreationDate`, поэтому «одинаковый» документ каждый
раз новый файл. Теперь форма собирается **один раз**, сохраняется в общее
файловое хранилище (`app/storage.py`, задача #101) и дальше отдаётся оттуда
побайтово.

Порядок при скачивании (`read_or_store`):

1. ключа в базе нет — собрать форму, сохранить её `storage.save_bytes`,
   записать полученный ключ в колонку счёта (или строки акта), зарегистрировать
   загрузку в реестре `uploaded_file` (`uploader_kind = NULL`: загрузка
   служебная, человека за ней нет) и вернуть прочитанное из хранилища;
2. ключ есть, а объекта в хранилище нет (бакет почистили, объект потерялся) —
   собрать форму заново и перезаписать **по тому же ключу** `storage.put_raw`:
   ключ в базе остаётся прежним, ссылка не меняется;
3. ключ есть и объект на месте — просто прочитать.

Ответ всегда читается из хранилища, а не отдаётся из памяти: так тело ответа
совпадает с тем объектом, который лежит в бакете, и повторное скачивание
действительно повторяет сохранённый файл, а не свежую сборку.

**Почему ключ строится по `invoice.id`, а не по номеру.** Номер счёта —
`СЧ-<год>-<id>` (`app/models/invoice.py`), то есть кириллица. Кириллица в имени
объекта в бакете — это лишние проблемы с кодировкой ключа и с подписью запросов,
а идентификатор неизменяем и уникален. Имя файла для человека от этого не
меняется: `invoice-<номер>.pdf` / `act-<номер>.pdf` собирает вызывающая ручка
(`app/api/billing.py`), а не этот модуль, — модуль отвечает только за байты.

**Что этот модуль не делает.** Он не меняет контракт ручек скачивания: коды,
заголовки и имена файлов остаются в `app/api/billing.py`. Он не знает ни про
`/uploads/{key}`, ни про `app/file_access.can_read`: у сгенерированных документов
своя ручка, потому что у файла есть имя и `Content-Disposition: attachment`,
которых общий маршрут не даёт намеренно. Правило записано в `docs/file-access.md`.

Ленивая материализация — решение задачи: событие (выставление счёта, оплата)
файл не создаёт, его фиксирует первое скачивание. Бэкфилла миграцией нет, у
исторических счетов `invoice_file_key` остаётся `NULL` до первого скачивания.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import billing_forms
from app.file_access import register_upload
from app.invoice_status import ACT_KIND
from app.models.invoice import Invoice, InvoiceDocument
from app.storage import storage

# Значения `uploaded_file.purpose` для сгенерированных документов. Колонка —
# `String(32)`, значения короткие намеренно.
INVOICE_PURPOSE = "invoice"
ACT_PURPOSE = "act"

# Тип содержимого печатной формы. То же значение объявлено в `app/api/billing.py`
# (`PDF_MEDIA_TYPE`) и отдаётся клиенту в заголовке `Content-Type`: здесь оно
# нужно хранилищу, чтобы объект в бакете имел правильный тип. Импортировать его
# из `app.api.billing` нельзя — роутер сам импортирует этот модуль, и получился
# бы цикл.
PDF_MEDIA_TYPE = "application/pdf"

# Виды документов, которые умеет этот модуль. Значения совпадают с `purpose` в
# реестре загрузок: одна и та же строка отвечает и за файл, и за учёт.
DOCUMENT_KINDS = (INVOICE_PURPOSE, ACT_PURPOSE)


def _act_document(db: Session, invoice: Invoice) -> InvoiceDocument | None:
    """Строка акта по счёту. Появляется только при оплате (`app/invoice_status.py`)."""
    return db.scalar(
        select(InvoiceDocument).where(
            InvoiceDocument.invoice_id == invoice.id,
            InvoiceDocument.kind == ACT_KIND,
        )
    )


def _current_key(db: Session, invoice: Invoice, kind: str) -> str | None:
    """Ключ хранилища, записанный для этого документа. `None` — файла ещё нет.

    Для счёта ключ лежит в самой строке счёта, для акта — в строке
    `invoice_documents`: у одного счёта акт один (`UNIQUE (invoice_id, kind)`).
    """
    if kind == INVOICE_PURPOSE:
        return invoice.invoice_file_key
    document = _act_document(db, invoice)
    return None if document is None else document.file_key


def _remember_key(db: Session, invoice: Invoice, kind: str, key: str) -> bool:
    """Записать ключ в колонку. `False` — записывать некуда.

    Строки акта нет — ключ класть некуда: акт заводит оплата, а не скачивание, и
    этот модуль строку не создаёт. Такая ситуация до ручки не доходит (она
    отвечает `404` до первого скачивания акта), поэтому файл остаётся
    несохранённым — см. `read_or_store`.
    """
    if kind == INVOICE_PURPOSE:
        invoice.invoice_file_key = key
        return True
    document = _act_document(db, invoice)
    if document is None:
        return False
    document.file_key = key
    return True


def _object_name(invoice: Invoice, kind: str) -> str:
    """Имя объекта в хранилище: `invoices/<вид>-<id>.pdf`.

    `storage.save_bytes` добавит к нему подпапку дня (`2026-10-29/...`), поэтому
    итоговый ключ выглядит как `2026-10-29/invoices/invoice-7.pdf`.
    """
    return f"invoices/{kind}-{invoice.id}.pdf"


def _build(invoice: Invoice, kind: str) -> bytes:
    """Собрать печатную форму. Генератор остаётся чистым и про хранилище не знает."""
    if kind == INVOICE_PURPOSE:
        return billing_forms.invoice_pdf(invoice)
    if kind == ACT_PURPOSE:
        return billing_forms.act_pdf(invoice)
    raise ValueError(f"Неизвестный вид документа: {kind!r}")


def read_or_store(db: Session, invoice: Invoice, kind: str) -> bytes:
    """Байты печатной формы: из хранилища, а при первом обращении — сохранённые.

    `kind` — `INVOICE_PURPOSE` (`"invoice"`) или `ACT_PURPOSE` (`"act"`).

    Первое скачивание собирает форму и фиксирует её: ключ уходит в колонку, а
    запись реестра — в ту же транзакцию (`register_upload(..., commit=False)`),
    поэтому «ключ есть, а учёта нет» не бывает. Сам объект в хранилище в
    транзакцию базы не входит: он записан до коммита, и сбой коммита оставит
    объект без ссылки — это то же поведение, что у импорта «Места».

    Гонка двух первых скачиваний принята: оба соберут форму и запишут её по
    одному ключу, в бакете останется последняя запись, и только первый и второй
    ответы могут различаться. Побайтовая повторяемость нужна повторному
    скачиванию, а не первому.
    """
    if kind not in DOCUMENT_KINDS:
        raise ValueError(f"Неизвестный вид документа: {kind!r}")
    key = _current_key(db, invoice, kind)
    if key is None:
        pdf = _build(invoice, kind)
        key = storage.save_bytes(pdf, _object_name(invoice, kind), content_type=PDF_MEDIA_TYPE)
        if not _remember_key(db, invoice, kind, key):
            # Строки акта нет — записывать ключ некуда. Форма отдаётся как есть:
            # выдумывать строку `invoice_documents` этот модуль не должен, а
            # терять ответ из-за отсутствия строки, которую заводит оплата,
            # незачем. До ручки этот путь не доходит: она отвечает `404`.
            return pdf
        register_upload(db, key, None, purpose=kind, commit=False)
        db.commit()
        return storage.read_bytes(key)
    if not storage.exists(key):
        # Ключ есть, объекта нет: пересобираем и перезаписываем по тому же
        # ключу. Ключ в базе не меняется — меняется только содержимое объекта.
        storage.put_raw(_build(invoice, kind), key, content_type=PDF_MEDIA_TYPE)
    return storage.read_bytes(key)
