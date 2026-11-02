"""Печатные формы счёта и акта: файл хранится в хранилище, а не собирается заново.

Задача #104: счёт и акт перестают собираться на каждый запрос. Форма собирается
один раз, сохраняется в общее файловое хранилище (`app/storage.py`, #101) и
дальше отдаётся оттуда побайтово. Проверяется ровно то, что обещано постановкой:

* первое скачивание создаёт ровно один объект в хранилище и ровно одну строку
  `uploaded_file` с этим ключом, `purpose='invoice'`, `uploader_kind IS NULL`;
* ключ записан в колонку счёта (`invoices.invoice_file_key`) и совпадает с
  ключом объекта;
* второе скачивание отдаёт те же байты и **не** зовёт генератор: подменённый
  `billing_forms.invoice_pdf`, возвращающий другие байты, на ответ не влияет;
* акт до оплаты — `404`, ключа нет и объекта нет; после оплаты файл появляется
  с `purpose='act'`;
* чужой счёт — `404`, и файл не создаётся;
* объект, удалённый из хранилища при живом ключе, пересоздаётся по тому же ключу;
* сохранённый PDF читается `pypdf` и содержит номер счёта;
* на пути скачивания нет `storage.exists`: файл читается сразу, а пересборка
  случается только по `StorageNotFoundError` (иначе сбой хранилища затирал бы
  выданный документ свежей сборкой);
* гонка регистрации в реестре не даёт `500`: `IntegrityError` на уникальном
  ключе гасится откатом, и ответ всё равно приходит из хранилища.

Хелперы (`owner`, `add_tariff`, `purchase_id`, `set_status`) берутся из
`tests/test_billing.py`: это тот же сценарий выставления счёта, и вторая копия
обвязчика разошлась бы с первой. Сам `test_billing.py` этой задачей не правится:
там лежит проверка неизменности контракта ручек.

Хранилище подменено autouse-фикстурой `upload_storage` из `conftest.py`:
`app.invoice_files.storage` смотрит в `tmp_path`, а не в `app/backend/uploads`
рабочей копии.
"""

import io
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import billing_forms, invoice_files
from app.invoice_files import ACT_PURPOSE, INVOICE_PURPOSE
from app.models.invoice import Invoice, InvoiceDocument
from app.models.uploaded_file import UploadedFile
from app.storage import LocalStorage
from tests.test_billing import INVOICE_URL, PAID, add_tariff, owner, purchase_id, set_status


def fresh_invoice(db_session: Session, invoice_id: int) -> Invoice:
    """Строка счёта с перечитанными полями.

    Сессия теста и сессия ручки — одна и та же (dependency override), но
    `invoice_file_key` пишет ручка: перечитываем, чтобы тест видел базу, а не
    копию в identity map.
    """
    db_session.expire_all()
    invoice = db_session.get(Invoice, invoice_id)
    assert invoice is not None
    return invoice


def act_document(db_session: Session, invoice_id: int) -> InvoiceDocument:
    db_session.expire_all()
    document = db_session.scalar(
        select(InvoiceDocument).where(InvoiceDocument.invoice_id == invoice_id)
    )
    assert document is not None, "после оплаты строка акта обязана быть"
    return document


def registered(db_session: Session, key: str) -> list[UploadedFile]:
    """Строки реестра загрузок с этим ключом: ключ уникален, строка одна."""
    db_session.expire_all()
    return list(db_session.scalars(select(UploadedFile).where(UploadedFile.key == key)))


def stored_keys(upload_storage: LocalStorage) -> list[str]:
    """Все объекты в тестовом хранилище: их число — часть критериев."""
    return upload_storage.list_folder("")


def pdf_text(body: bytes) -> str:
    """Текст готового файла: содержимое PDF проверяется извлечением, не подстрокой."""
    return "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(body)).pages)


# --- 1. Счёт -------------------------------------------------------------------


def test_the_first_download_stores_one_object_and_one_registry_row(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    response = client.get(f"{INVOICE_URL}/{invoice_id}/file")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")

    invoice = fresh_invoice(db_session, invoice_id)
    key = invoice.invoice_file_key
    assert key is not None
    # Ключ строится по `invoice.id`, а не по номеру: кириллицы в бакете нет.
    assert key.endswith(f"invoices/invoice-{invoice_id}.pdf")
    assert "СЧ-" not in key

    # Ровно один объект и ровно одна строка реестра — на этот ключ.
    assert stored_keys(upload_storage) == [key]
    rows = registered(db_session, key)
    assert len(rows) == 1
    assert rows[0].purpose == INVOICE_PURPOSE
    # Загрузка служебная: человека за ней нет.
    assert rows[0].uploader_kind is None
    assert rows[0].uploader_id is None

    # Тело ответа — байты объекта, а не отдельная сборка в памяти.
    assert upload_storage.read_bytes(key) == response.content


def test_the_second_download_returns_the_saved_bytes_without_rendering(
    client: TestClient,
    db_session: Session,
    upload_storage: LocalStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Повторное скачивание не обращается к генератору.

    Генератор подменяется на функцию с другими байтами: если бы ручка собирала
    форму заново, ответ изменился бы. Он не меняется — значит, читается объект.
    """
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    first = client.get(f"{INVOICE_URL}/{invoice_id}/file")
    assert first.status_code == 200, first.text

    def other_pdf(invoice: Invoice) -> bytes:
        return b"%PDF-1.4 other bytes"

    monkeypatch.setattr(billing_forms, "invoice_pdf", other_pdf)
    second = client.get(f"{INVOICE_URL}/{invoice_id}/file")

    assert second.status_code == 200, second.text
    assert second.content == first.content
    # Ни второго объекта, ни второй строки реестра не появилось.
    invoice = fresh_invoice(db_session, invoice_id)
    assert invoice.invoice_file_key is not None
    assert stored_keys(upload_storage) == [invoice.invoice_file_key]
    assert len(registered(db_session, invoice.invoice_file_key)) == 1


def test_the_saved_pdf_is_readable_and_contains_the_invoice_number(
    client: TestClient, db_session: Session
) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    body = client.get(f"{INVOICE_URL}/{invoice_id}/file").content

    invoice = fresh_invoice(db_session, invoice_id)
    assert f"Счёт № {invoice.number}" in pdf_text(body)


def test_the_download_name_stays_the_same(client: TestClient, db_session: Session) -> None:
    """Имя файла собирает ручка, а не модуль хранилища: контракт прежний."""
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    disposition = client.get(f"{INVOICE_URL}/{invoice_id}/file").headers["content-disposition"]

    invoice = fresh_invoice(db_session, invoice_id)
    assert disposition.startswith("attachment;")
    assert f"filename*=UTF-8''{quote(f'invoice-{invoice.number}.pdf')}" in disposition


# --- 2. Акт --------------------------------------------------------------------


def test_the_act_before_payment_is_not_found_and_creates_no_file(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    response = client.get(f"{INVOICE_URL}/{invoice_id}/act-file")

    assert response.status_code == 404
    # До оплаты строки акта нет вовсе — значит, и ключа нет, и файла нет.
    db_session.expire_all()
    assert (
        db_session.scalar(select(InvoiceDocument).where(InvoiceDocument.invoice_id == invoice_id))
        is None
    )
    assert stored_keys(upload_storage) == []
    assert list(db_session.scalars(select(UploadedFile))) == []


def test_the_act_after_payment_is_stored_with_its_own_purpose(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    assert set_status(client, invoice_id, PAID).status_code == 200

    response = client.get(f"{INVOICE_URL}/{invoice_id}/act-file")

    assert response.status_code == 200, response.text
    assert response.content.startswith(b"%PDF-")
    document = act_document(db_session, invoice_id)
    key = document.file_key
    assert key is not None
    assert key.endswith(f"invoices/act-{invoice_id}.pdf")
    assert stored_keys(upload_storage) == [key]
    rows = registered(db_session, key)
    assert len(rows) == 1
    assert rows[0].purpose == ACT_PURPOSE
    assert rows[0].uploader_kind is None
    assert upload_storage.read_bytes(key) == response.content

    # Акт тоже отдаётся сохранённым: повторный запрос не пересобирает форму.
    assert client.get(f"{INVOICE_URL}/{invoice_id}/act-file").content == response.content


# --- 3. Чужой счёт и потерянный объект ----------------------------------------


def test_the_foreign_invoice_is_not_found_and_nothing_is_stored(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    owner(client, db_session, email="first@example.com")
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    client.post("/api/auth/logout")
    owner(client, db_session, email="second@example.com", inn="7701234568")

    assert client.get(f"{INVOICE_URL}/{invoice_id}/file").status_code == 404

    invoice = fresh_invoice(db_session, invoice_id)
    assert invoice.invoice_file_key is None
    assert stored_keys(upload_storage) == []


def test_a_lost_object_is_restored_under_the_same_key(
    client: TestClient, db_session: Session, upload_storage: LocalStorage
) -> None:
    """Ключ в базе есть, объекта в хранилище нет: файл пересоздаётся по нему же.

    Ключ при этом не меняется — иначе сохранённая ссылка и запись реестра
    указывали бы в пустоту.
    """
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    first = client.get(f"{INVOICE_URL}/{invoice_id}/file")
    assert first.status_code == 200, first.text
    key = fresh_invoice(db_session, invoice_id).invoice_file_key
    assert key is not None

    upload_storage.delete(key)
    assert upload_storage.exists(key) is False

    second = client.get(f"{INVOICE_URL}/{invoice_id}/file")

    assert second.status_code == 200, second.text
    assert second.content.startswith(b"%PDF-")
    assert fresh_invoice(db_session, invoice_id).invoice_file_key == key
    assert upload_storage.exists(key) is True
    assert upload_storage.read_bytes(key) == second.content
    # Запись реестра осталась одна: ключ тот же, повторной регистрации нет.
    assert len(registered(db_session, key)) == 1


# --- 4. Доработка по ревью #107 ------------------------------------------------


def test_the_download_never_asks_the_storage_whether_the_object_exists(
    client: TestClient,
    db_session: Session,
    upload_storage: LocalStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`storage.exists` на пути скачивания не вызывается вовсе.

    `S3Storage.exists` превращает любую ошибку boto3 в `False`: при 503 SlowDown
    или таймауте сохранённый счёт выглядел бы пропавшим и затирался бы свежей
    сборкой с другим `/CreationDate`. Поэтому файл читается сразу, а пересборку
    решает только `StorageNotFoundError` от самого чтения — это и проверяется:
    подменённый `exists`, который падает при любом вызове, скачиванию не мешает.

    Заодно закреплено второе следствие правки: на повторное скачивание уходит
    одно обращение к хранилищу (GET), а не HEAD + GET.
    """

    def fail_exists(name: str) -> bool:
        raise AssertionError(f"storage.exists вызван на пути скачивания: {name}")

    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    # Первое скачивание пишет объект; `exists` здесь тоже не нужен.
    monkeypatch.setattr(LocalStorage, "exists", fail_exists)
    first = client.get(f"{INVOICE_URL}/{invoice_id}/file")
    second = client.get(f"{INVOICE_URL}/{invoice_id}/file")

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.content == first.content


def test_the_lost_registry_race_does_not_turn_into_an_error(
    client: TestClient,
    db_session: Session,
    upload_storage: LocalStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`IntegrityError` на уникальном `uploaded_file.key` гасится откатом.

    Гонка двух первых скачиваний одного счёта: соседний запрос успел вставить
    строку реестра первым, и наш `flush` падает на уникальном индексе. Ручка
    обязана отдать PDF, а не `500`, — ключ к этому моменту записан, объект в
    хранилище лежит. Здесь падение вставки подставляется подменой `register_upload`:
    настоящую гонку двух потоков в SQLite-прогоне не воспроизвести.
    """
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    def duplicate_key(*args: object, **kwargs: object) -> None:
        raise IntegrityError("INSERT INTO uploaded_file", {}, Exception("duplicate key"))

    monkeypatch.setattr(invoice_files, "register_upload", duplicate_key)
    response = client.get(f"{INVOICE_URL}/{invoice_id}/file")

    assert response.status_code == 200, response.text
    assert response.content.startswith(b"%PDF-")
    # Откат снял нашу неудавшуюся вставку (и назначение ключа в этой сессии —
    # поэтому в базе ключа нет), но объект в хранилище остался и именно он
    # отдан клиенту.
    keys = stored_keys(upload_storage)
    assert len(keys) == 1
    assert upload_storage.read_bytes(keys[0]) == response.content
