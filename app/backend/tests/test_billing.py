"""Счета организации: покупка, статусы и печатные формы (issue #49, #61).

Критерии готовности разложены по блокам:

* покупка заводит счёт со снимком реквизитов покупателя и предмета, номер вида
  `СЧ-<год>-<id>`, статус «Новый» и подписи от сервера;
* повторный клик не плодит счета: живой `new` **за тот же предмет** возвращается
  как `200`, а уже выбранный тариф — это `409`;
* пустые название и ИНН, незнакомый тариф, чужая роль и чужой счёт дают разные
  коды: `409`, `404`, `403` и `404`;
* `new → paid` привязывает организации тариф и создаёт акт, `paid → closed`
  разрешён, `cancelled → paid` — `409`;
* счёт за решение (#61) покупается тем же путём, оплата выдаёт право и **не
  трогает** тариф организации, а счета за тариф и за решение не мешают друг другу;
* оба файла — PDF, отдаются вложением и содержат название, ИНН и сумму; акт до
  оплаты — `404`.

Тесты идут на SQLite: `SELECT … FOR UPDATE` там вырождается в no-op, поэтому
блокировки проверяются чтением итогового состояния, а не параллельными запросами.
"""

import io
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from pypdf import PdfReader
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import billing_forms, solutions
from app.billing_forms import EMPTY_VALUE
from app.invoice_status import INVOICE_STATUS_LABELS, is_allowed, status_label
from app.models.invoice import Invoice, InvoiceDocument
from app.models.organization import Organization
from app.models.solution import OrganizationSolution
from app.models.tariff import Tariff
from app.pricing import format_invoice_amount
from tests.conftest import add_solution, organizations_for, sign_in

# Неразрывный пробел — разделитель разрядов в подписи суммы.
NBSP = "\u00a0"

BUYER_NAME = "ООО «Домовой»"
BUYER_INN = "7701234567"
BUYER_KPP = "770101001"
BUYER_OGRN = "1027700132195"
BUYER_ADDRESS = "г. Москва, ул. Тверская, д. 1"

INVOICE_URL = "/api/billing/invoices"
PAID = "paid"
CLOSED = "closed"
CANCELLED = "cancelled"

INVALID_STATUS_DETAIL = "Так нельзя изменить статус счёта"


def as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: для сравнения считаем его UTC.

    Приложение приводит даты тем же способом (`app.solutions._as_utc`), а тесту
    нужен этот помощник там, где он сверяет срок права с «сейчас».
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def add_tariff(
    db_session: Session,
    name: str = "Старт",
    amount: str = "10000.00",
    period: str = "month",
    is_visible: bool = True,
) -> Tariff:
    """Тариф прайса прямо в базе: покупка читает его по `id`."""
    tariff = Tariff(
        name=name,
        description="До 10 пользователей",
        amount=Decimal(amount),
        currency="RUB",
        period=period,
        unit_label=None,
        position=1,
        is_visible=is_visible,
    )
    db_session.add(tariff)
    db_session.commit()
    db_session.refresh(tariff)
    return tariff


def owner(
    client: TestClient,
    db_session: Session,
    role: str = "owner",
    name: str | None = BUYER_NAME,
    inn: str | None = BUYER_INN,
    email: str = "owner@example.com",
) -> Organization:
    """Войти участником организации с заполненными реквизитами.

    Реквизиты задаются прямо в строке организации: в проекте их заполняет поиск
    по ИНН, а счёту нужен уже готовый снимок.
    """
    user = sign_in(client, db_session, email=email)
    organization, _ = organizations_for(db_session, user, role=role, name=name, inn=inn)
    organization.kpp = BUYER_KPP
    organization.ogrn = BUYER_OGRN
    organization.address = BUYER_ADDRESS
    db_session.commit()
    db_session.refresh(organization)
    return organization


def purchase(client: TestClient, tariff_id: int) -> Response:
    """POST покупки тарифа. Возвращает ответ целиком: тесты смотрят и код, и тело."""
    return client.post(INVOICE_URL, json={"tariff_id": tariff_id})


def purchase_solution(client: TestClient, solution_id: int) -> Response:
    """POST покупки решения: та же ручка, другое поле предмета."""
    return client.post(INVOICE_URL, json={"solution_id": solution_id})


def purchase_id(client: TestClient, tariff_id: int) -> int:
    """Идентификатор успешно выставленного счёта: покупка обязана пройти."""
    response = purchase(client, tariff_id)
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def set_status(client: TestClient, invoice_id: int, value: str) -> Response:
    return client.patch(f"{INVOICE_URL}/{invoice_id}", json={"status": value})


def add_invoice(
    db_session: Session, organization: Organization, tariff: Tariff, status: str = "new"
) -> Invoice:
    """Счёт прямо в базе: нужен там, где ручка покупки отказала бы раньше."""
    invoice = Invoice(
        organization_id=organization.id,
        tariff_id=tariff.id,
        number="СЧ-2026-1",
        status=status,
        amount=tariff.amount,
        currency="RUB",
        buyer_name=BUYER_NAME,
        buyer_inn=BUYER_INN,
    )
    db_session.add(invoice)
    db_session.commit()
    db_session.refresh(invoice)
    return invoice


def invoices_of(db_session: Session, organization_id: int) -> list[Invoice]:
    return list(
        db_session.scalars(
            select(Invoice).where(Invoice.organization_id == organization_id).order_by(Invoice.id)
        )
    )


def acts_of(db_session: Session, invoice_id: int) -> list[InvoiceDocument]:
    return list(
        db_session.scalars(select(InvoiceDocument).where(InvoiceDocument.invoice_id == invoice_id))
    )


# --- 1. Правила переходов без HTTP --------------------------------------------


def test_status_labels_are_russian() -> None:
    assert INVOICE_STATUS_LABELS == {
        "new": "Новый",
        "paid": "Оплачен",
        "closed": "Закрыт",
        "cancelled": "Отменён",
    }


def test_status_label_falls_back_to_the_value() -> None:
    """Незнакомый статус показывается как есть, а не роняет ответ."""
    assert status_label("archived") == "archived"


def test_only_declared_transitions_are_allowed() -> None:
    assert is_allowed("new", PAID)
    assert is_allowed("new", CANCELLED)
    assert is_allowed(PAID, CLOSED)

    assert not is_allowed(PAID, PAID)
    assert not is_allowed(CLOSED, PAID)
    assert not is_allowed(CANCELLED, PAID)
    assert not is_allowed(CLOSED, CANCELLED)
    assert not is_allowed("new", CLOSED)


# --- 2. Покупка ---------------------------------------------------------------


def test_purchase_creates_invoice_with_buyer_snapshot(
    client: TestClient, db_session: Session
) -> None:
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)

    response = purchase(client, tariff.id)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["number"].startswith("СЧ-") and body["number"].endswith(f"-{body['id']}")
    assert body["status"] == "new"
    assert body["status_label"] == "Новый"
    assert body["item_kind"] == "tariff"
    assert body["amount"] == "10000.00"
    assert body["currency"] == "RUB"
    assert body["amount_label"] == f"10{NBSP}000 ₽ в месяц"
    assert body["tariff_name"] == "Старт"
    assert body["tariff_period"] == "month"
    assert body["buyer_name"] == BUYER_NAME
    assert body["buyer_inn"] == BUYER_INN
    assert body["buyer_kpp"] == BUYER_KPP
    assert body["buyer_ogrn"] == BUYER_OGRN
    assert body["buyer_address"] == BUYER_ADDRESS
    assert body["has_act"] is False
    assert body["can_manage"] is True
    assert body["paid_at"] is None

    stored = invoices_of(db_session, organization.id)
    assert len(stored) == 1
    assert stored[0].number == body["number"]
    # Тариф организации покупкой ещё не назначается: это делает оплата.
    assert organization.tariff_id is None


def test_second_purchase_returns_the_live_invoice_and_creates_nothing(
    client: TestClient, db_session: Session
) -> None:
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    second = purchase(client, tariff.id)

    assert second.status_code == 200, second.text
    assert second.json()["id"] == invoice_id
    assert len(invoices_of(db_session, organization.id)) == 1


def test_purchase_after_payment_is_a_conflict(client: TestClient, db_session: Session) -> None:
    """Тариф уже выбран: второй раз его не покупают."""
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    assert set_status(client, invoice_id, PAID).status_code == 200

    response = purchase(client, tariff.id)

    assert response.status_code == 409
    assert response.json()["detail"] == "Тариф организации уже выбран"


def test_purchase_without_name_and_inn_is_a_conflict(
    client: TestClient, db_session: Session
) -> None:
    owner(client, db_session, name=None, inn=None)
    tariff = add_tariff(db_session)

    response = purchase(client, tariff.id)

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "Заполните название и ИНН организации на странице «Организация»"
    )


def test_purchase_of_unknown_tariff_is_not_found(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)

    response = purchase(client, 999)

    assert response.status_code == 404
    assert response.json()["detail"] == "Тариф не найден"


def test_purchase_is_forbidden_to_a_role_without_edit_rights(
    client: TestClient, db_session: Session
) -> None:
    """`manager` счета видит, но не выставляет."""
    owner(client, db_session, role="manager")
    tariff = add_tariff(db_session)

    response = purchase(client, tariff.id)

    assert response.status_code == 403
    assert response.json()["detail"] == "Недостаточно прав"


def test_purchase_requires_a_session(client: TestClient, db_session: Session) -> None:
    add_tariff(db_session)

    assert purchase(client, 1).status_code == 401


def test_purchase_works_on_a_closed_trial(client: TestClient, db_session: Session) -> None:
    """Закрытый кабинет покупку не блокирует: ради неё он и открывается."""
    user = sign_in(client, db_session, email="locked@example.com", trial_active=False)
    organization, _ = organizations_for(db_session, user, name=BUYER_NAME, inn=BUYER_INN)
    tariff = add_tariff(db_session)

    response = purchase(client, tariff.id)

    assert response.status_code == 201, response.text
    assert len(invoices_of(db_session, organization.id)) == 1


def test_purchase_keeps_the_snapshot_when_the_tariff_changes(
    client: TestClient, db_session: Session
) -> None:
    """Снимок предмета не едет вслед за прайсом."""
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    tariff.name = "Другое имя"
    tariff.amount = Decimal("999.00")
    db_session.commit()

    body = client.get(f"{INVOICE_URL}/{invoice_id}").json()

    assert body["tariff_name"] == "Старт"
    assert body["amount"] == "10000.00"


# --- 3. Статусы ---------------------------------------------------------------


def test_paid_binds_the_tariff_and_creates_the_act(client: TestClient, db_session: Session) -> None:
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    response = set_status(client, invoice_id, PAID)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == PAID
    assert body["status_label"] == "Оплачен"
    assert body["paid_at"] is not None
    assert body["has_act"] is True

    db_session.refresh(organization)
    assert organization.tariff_id == tariff.id
    assert len(acts_of(db_session, invoice_id)) == 1
    # Запись тарифа открывает кабинет: пробный режим доступа больше не действует.
    assert client.get("/api/tariffs/current").json()["tariff"]["id"] == tariff.id


def test_paid_invoice_cannot_be_paid_twice(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    set_status(client, invoice_id, PAID)

    response = set_status(client, invoice_id, PAID)

    assert response.status_code == 409
    assert response.json()["detail"] == INVALID_STATUS_DETAIL
    assert len(acts_of(db_session, invoice_id)) == 1


def test_paid_invoice_can_be_closed(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    set_status(client, invoice_id, PAID)

    response = set_status(client, invoice_id, CLOSED)

    assert response.status_code == 200, response.text
    assert response.json()["status"] == CLOSED
    assert response.json()["status_label"] == "Закрыт"


def test_cancelled_invoice_cannot_be_paid(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    set_status(client, invoice_id, CANCELLED)

    response = set_status(client, invoice_id, PAID)

    assert response.status_code == 409
    assert response.json()["detail"] == INVALID_STATUS_DETAIL


def test_status_change_is_forbidden_to_a_role_without_edit_rights(
    client: TestClient, db_session: Session
) -> None:
    organization = owner(client, db_session, role="manager")
    tariff = add_tariff(db_session)
    invoice = add_invoice(db_session, organization, tariff)

    response = set_status(client, invoice.id, PAID)

    assert response.status_code == 403
    assert response.json()["detail"] == "Недостаточно прав"


def test_foreign_invoice_is_not_found(client: TestClient, db_session: Session) -> None:
    owner(client, db_session, email="first@example.com")
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    client.post("/api/auth/logout")

    owner(client, db_session, email="second@example.com", inn="7701234568")

    assert client.get(f"{INVOICE_URL}/{invoice_id}").status_code == 404
    assert set_status(client, invoice_id, PAID).status_code == 404


def test_paid_requires_the_organization_to_have_no_other_tariff(
    client: TestClient, db_session: Session
) -> None:
    """Смена тарифа покупкой не делается: у организации уже есть другой."""
    organization = owner(client, db_session)
    other = add_tariff(db_session, name="Максимум", amount="90000.00", period="year")
    tariff = add_tariff(db_session, name="Старт")
    organization.tariff_id = other.id
    db_session.commit()
    invoice = add_invoice(db_session, organization, tariff)

    response = set_status(client, invoice.id, PAID)

    assert response.status_code == 409
    assert response.json()["detail"] == "Тариф организации уже выбран"
    assert acts_of(db_session, invoice.id) == []


def test_unknown_status_is_rejected_by_the_schema(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    response = set_status(client, invoice_id, "new")

    assert response.status_code == 422


# --- 4. Список и чтение -------------------------------------------------------


def test_invoice_list_is_ordered_fresh_first(client: TestClient, db_session: Session) -> None:
    organization = owner(client, db_session)
    first = add_tariff(db_session, name="Старт")
    second = add_tariff(db_session, name="Максимум", amount="90000.00", period="year")
    first_id = purchase_id(client, first.id)
    # Второй счёт получаем отменой первого: живой `new` вернулся бы как 200.
    set_status(client, first_id, CANCELLED)
    second_id = purchase_id(client, second.id)

    response = client.get(INVOICE_URL)

    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()] == [second_id, first_id]
    assert len(invoices_of(db_session, organization.id)) == 2


def test_invoice_list_requires_a_session(client: TestClient) -> None:
    assert client.get(INVOICE_URL).status_code == 401


def test_invoice_list_is_empty_after_signing_in(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)

    response = client.get(INVOICE_URL)

    assert response.status_code == 200
    assert response.json() == []


def test_organizations_do_not_see_each_other_invoices(
    client: TestClient, db_session: Session
) -> None:
    owner(client, db_session, email="first@example.com")
    tariff = add_tariff(db_session)
    purchase_id(client, tariff.id)
    client.post("/api/auth/logout")

    owner(client, db_session, email="second@example.com", inn="7701234568")

    assert client.get(INVOICE_URL).json() == []


# --- 5. Печатные формы --------------------------------------------------------
#
# Обе формы — PDF: тело ответа двоичное, поэтому содержимое проверяется не
# поиском подстроки в тексте, а извлечением текста из готового файла. fpdf2
# пишет ToUnicode-CMap, поэтому кириллица из файла читается.


def pdf_pages(body: bytes) -> list[str]:
    """Текст по страницам скачанного файла: проверяются и содержимое, и объём."""
    reader = PdfReader(io.BytesIO(body))
    return [page.extract_text() for page in reader.pages]


def pdf_text(body: bytes) -> str:
    """Весь текст файла.

    Неразрывный пробел приводится к обычному: разделитель разрядов в сумме —
    типографский символ, и сравнивать его в тесте неудобно.
    """
    return "\n".join(pdf_pages(body)).replace(NBSP, " ")


def amount_text(invoice: Invoice) -> str:
    """Сумма счёта такой, какой она должна быть в файле: без неразрывного пробела."""
    label = format_invoice_amount(invoice.amount, invoice.currency, invoice.tariff_period)
    return label.replace(NBSP, " ")


def ascii_filename(disposition: str) -> str:
    """ASCII-запасное имя из `filename=`: его понимают старые клиенты."""
    return disposition.split('filename="', 1)[1].split('"', 1)[0]


def test_invoice_file_is_downloaded_as_a_pdf(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    invoice = db_session.get(Invoice, invoice_id)
    assert invoice is not None
    assert invoice.created_at is not None

    response = client.get(f"{INVOICE_URL}/{invoice_id}/file")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    # Кириллицу в заголовок положить нельзя (latin-1), поэтому имя дублируется
    # по RFC 5987, а ASCII-вариант остаётся для старых клиентов.
    assert f"filename*=UTF-8''{quote(f'invoice-{invoice.number}.pdf')}" in disposition
    assert ascii_filename(disposition).isascii()
    assert ascii_filename(disposition).endswith(".pdf")

    pages = pdf_pages(response.content)
    assert len(pages) == 1
    text = pdf_text(response.content)
    assert f"Счёт № {invoice.number}" in text
    assert f"Дата: {invoice.created_at:%d.%m.%Y}" in text
    assert "Поставщик" in text
    assert "Покупатель" in text
    assert "Предмет" in text
    assert BUYER_NAME in text
    assert BUYER_INN in text
    assert BUYER_KPP in text
    assert BUYER_OGRN in text
    assert BUYER_ADDRESS in text
    assert invoice.tariff_name is not None
    assert invoice.tariff_name in text
    assert amount_text(invoice) in text
    # Поставщика в проекте нет: блок подписан заглушкой, а не выдуманными данными.
    assert "данные поставщика будут заполнены позже" in text


def test_invoice_file_keeps_the_buyer_name_as_is(client: TestClient, db_session: Session) -> None:
    """`<` и `&` из карточки организации доходят до файла как есть.

    Экранировать в PDF нечего: HTML-сущностей в тексте быть не должно.
    """
    owner(client, db_session, name="ООО <Дом & Ко>")
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    text = pdf_text(client.get(f"{INVOICE_URL}/{invoice_id}/file").content)

    assert "ООО <Дом & Ко>" in text
    assert "&lt;" not in text
    assert "&amp;" not in text


def test_invoice_file_draws_a_dash_for_an_empty_requisite(
    client: TestClient, db_session: Session
) -> None:
    """У индивидуального предпринимателя нет КПП: пустая ячейка — прочерк."""
    organization = owner(client, db_session)
    organization.kpp = None
    db_session.commit()
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    text = pdf_text(client.get(f"{INVOICE_URL}/{invoice_id}/file").content)

    assert "КПП" in text
    assert EMPTY_VALUE in text


def test_missing_font_fails_with_a_clear_message(monkeypatch: pytest.MonkeyPatch) -> None:
    """Без шрифта с кириллицей форма не собирается: модуль падает с текстом.

    Core-шрифты PDF кириллицу не покрывают — молчаливая подстановка Helvetica
    дала бы пустые квадраты вместо букв, поэтому отсутствие файла это отказ.
    """
    invoice = Invoice(number="СЧ-2026-1", amount=Decimal("10000.00"), currency="RUB")
    monkeypatch.setattr(billing_forms, "FONT_REGULAR", "/nowhere/DejaVuSans.ttf")

    with pytest.raises(RuntimeError, match="fonts-dejavu-core"):
        billing_forms.invoice_pdf(invoice)


def test_act_file_is_not_found_before_payment(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)

    response = client.get(f"{INVOICE_URL}/{invoice_id}/act-file")

    assert response.status_code == 404
    assert response.json()["detail"] == "Акт по счёту ещё не сформирован"


def test_act_file_is_downloaded_after_payment(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    set_status(client, invoice_id, PAID)
    invoice = db_session.get(Invoice, invoice_id)
    assert invoice is not None
    assert invoice.paid_at is not None

    response = client.get(f"{INVOICE_URL}/{invoice_id}/act-file")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert f"filename*=UTF-8''{quote(f'act-{invoice.number}.pdf')}" in disposition
    assert ascii_filename(disposition).endswith(".pdf")

    assert len(pdf_pages(response.content)) == 1
    text = pdf_text(response.content)
    assert f"Акт № {invoice.number}" in text
    assert f"Дата: {invoice.paid_at:%d.%m.%Y}" in text
    assert BUYER_NAME in text
    assert BUYER_INN in text
    assert amount_text(invoice) in text


def test_foreign_invoice_file_is_not_found(client: TestClient, db_session: Session) -> None:
    owner(client, db_session, email="first@example.com")
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    client.post("/api/auth/logout")
    owner(client, db_session, email="second@example.com", inn="7701234568")

    assert client.get(f"{INVOICE_URL}/{invoice_id}/file").status_code == 404
    assert client.get(f"{INVOICE_URL}/{invoice_id}/act-file").status_code == 404


def test_manager_downloads_the_invoice_but_cannot_pay_it(
    client: TestClient, db_session: Session
) -> None:
    """Роль без права правки счёт видит и скачивает — но не меняет статус."""
    organization = owner(client, db_session, role="manager")
    tariff = add_tariff(db_session)
    invoice = add_invoice(db_session, organization, tariff)

    listed = client.get(INVOICE_URL).json()[0]
    assert listed["id"] == invoice.id
    # Право на смену статуса решает сервер: экран не держит свою копию правила.
    assert listed["can_manage"] is False
    assert client.get(f"{INVOICE_URL}/{invoice.id}/file").status_code == 200
    assert set_status(client, invoice.id, PAID).status_code == 403


# --- 6. Счёт за решение магазина улучшений (#61) -------------------------------


def rights_of(db_session: Session, organization_id: int) -> list[OrganizationSolution]:
    return list(
        db_session.scalars(
            select(OrganizationSolution).where(
                OrganizationSolution.organization_id == organization_id
            )
        )
    )


def test_purchase_of_a_solution_creates_an_invoice_with_the_snapshot(
    client: TestClient, db_session: Session
) -> None:
    """Счёт за решение: предмет-решение в снимке, тариф организации не тронут."""
    organization = owner(client, db_session)
    solution = add_solution(db_session, amount="500.00", period="month")

    response = purchase_solution(client, solution.id)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["item_kind"] == "solution"
    assert body["number"].startswith("СЧ-")
    assert body["status"] == "new"
    assert body["amount"] == "500.00"
    assert body["currency"] == "RUB"
    assert body["amount_label"] == "500 ₽ в месяц"
    # Снимок предмета лежит в колонках тарифа: печатные формы их и читают.
    assert body["tariff_name"] == "Уведомления в Telegram"
    assert body["tariff_period"] == "month"
    assert body["buyer_name"] == BUYER_NAME
    assert body["has_act"] is False

    stored = invoices_of(db_session, organization.id)
    assert len(stored) == 1
    assert stored[0].item_kind == "solution"
    assert stored[0].solution_id == solution.id
    assert stored[0].tariff_id is None
    # Покупка решения не выбирает организации тариф: кабинет она не открывает.
    db_session.refresh(organization)
    assert organization.tariff_id is None


def test_second_purchase_of_a_solution_returns_the_live_invoice(
    client: TestClient, db_session: Session
) -> None:
    organization = owner(client, db_session)
    solution = add_solution(db_session)
    first = purchase_solution(client, solution.id)
    assert first.status_code == 201, first.text

    second = purchase_solution(client, solution.id)

    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]
    assert len(invoices_of(db_session, organization.id)) == 1


def test_invoices_for_a_tariff_and_a_solution_do_not_block_each_other(
    client: TestClient, db_session: Session
) -> None:
    """Дедупликация сужена до того же предмета, а не «любого живого счёта»."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)
    solution = add_solution(db_session)
    tariff_invoice = purchase(client, tariff.id)
    assert tariff_invoice.status_code == 201, tariff_invoice.text

    solution_invoice = purchase_solution(client, solution.id)

    assert solution_invoice.status_code == 201, solution_invoice.text
    assert len(invoices_of(db_session, organization.id)) == 2

    # И обратный порядок: живой счёт за решение не мешает счёту за тариф.
    other = owner(client, db_session, email="second@example.com", inn="7701234568")
    tariff_again = add_tariff(db_session, name="Годовой", period="year")
    assert purchase_solution(client, solution.id).status_code == 201
    assert purchase(client, tariff_again.id).status_code == 201
    assert len(invoices_of(db_session, other.id)) == 2


def test_purchase_of_an_unknown_solution_is_not_found(
    client: TestClient, db_session: Session
) -> None:
    owner(client, db_session)

    response = purchase_solution(client, 999)

    assert response.status_code == 404
    assert response.json()["detail"] == "Решение не найдено"


def test_chosen_tariff_does_not_block_a_solution(client: TestClient, db_session: Session) -> None:
    """Тариф организации уже выбран — решение всё равно покупается."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)
    organization.tariff_id = tariff.id
    db_session.commit()
    solution = add_solution(db_session)

    response = purchase_solution(client, solution.id)

    assert response.status_code == 201, response.text


def test_hidden_solution_is_still_buyable_by_id(client: TestClient, db_session: Session) -> None:
    """Скрытая строка каталога списком не продаётся, но по `id` покупается."""
    owner(client, db_session)
    solution = add_solution(db_session, is_visible=False)

    assert purchase_solution(client, solution.id).status_code == 201


def test_payment_of_a_solution_invoice_grants_the_right_and_creates_the_act(
    client: TestClient, db_session: Session
) -> None:
    organization = owner(client, db_session)
    solution = add_solution(db_session)
    invoice_id = int(purchase_solution(client, solution.id).json()["id"])

    response = set_status(client, invoice_id, PAID)

    assert response.status_code == 200, response.text
    assert response.json()["has_act"] is True
    assert len(acts_of(db_session, invoice_id)) == 1
    assert client.get(f"{INVOICE_URL}/{invoice_id}/act-file").status_code == 200

    rights = rights_of(db_session, organization.id)
    assert len(rights) == 1
    assert rights[0].solution_id == solution.id
    assert rights[0].invoice_id == invoice_id
    assert rights[0].expires_at is not None
    # Оплата счёта за решение не привязывает организации тариф.
    db_session.refresh(organization)
    assert organization.tariff_id is None
    assert solutions.has_solution(db_session, organization.id, solution.code)


def test_payment_of_a_solution_invoice_keeps_a_chosen_tariff(
    client: TestClient, db_session: Session
) -> None:
    """У организации другой тариф — оплата решения его не меняет и не отказывает."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)
    organization.tariff_id = tariff.id
    db_session.commit()
    solution = add_solution(db_session)
    invoice_id = int(purchase_solution(client, solution.id).json()["id"])

    response = set_status(client, invoice_id, PAID)

    assert response.status_code == 200, response.text
    db_session.refresh(organization)
    assert organization.tariff_id == tariff.id


def test_second_paid_solution_invoice_renews_the_single_right(
    client: TestClient, db_session: Session
) -> None:
    """Вторая покупка того же решения продлевает право, а не заводит второе."""
    organization = owner(client, db_session)
    solution = add_solution(db_session)
    first_id = int(purchase_solution(client, solution.id).json()["id"])
    assert set_status(client, first_id, PAID).status_code == 200
    db_session.expire_all()
    first_expiry = rights_of(db_session, organization.id)[0].expires_at
    assert first_expiry is not None

    second_id = int(purchase_solution(client, solution.id).json()["id"])
    assert second_id != first_id
    assert set_status(client, second_id, PAID).status_code == 200

    rights = rights_of(db_session, organization.id)
    assert len(rights) == 1
    assert rights[0].expires_at is not None
    # Отсчёт от прежнего конца: месяц добавился к остатку, а не заменил его.
    assert rights[0].expires_at > first_expiry + timedelta(days=27)
    assert rights[0].invoice_id == second_id


def test_solution_expiry_counts_from_the_payment_moment(
    client: TestClient, db_session: Session
) -> None:
    organization = owner(client, db_session)
    solution = add_solution(db_session, period="month")
    invoice_id = int(purchase_solution(client, solution.id).json()["id"])

    assert set_status(client, invoice_id, PAID).status_code == 200

    expires_at = rights_of(db_session, organization.id)[0].expires_at
    assert expires_at is not None
    # Один календарный месяц от оплаты: границы проверяются с запасом в сутки.
    assert datetime.now(UTC) + timedelta(days=27) < as_utc(expires_at)
    assert as_utc(expires_at) < datetime.now(UTC) + timedelta(days=32)


def test_purchase_with_both_items_is_rejected(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)
    tariff = add_tariff(db_session)
    solution = add_solution(db_session)

    response = client.post(INVOICE_URL, json={"tariff_id": tariff.id, "solution_id": solution.id})

    assert response.status_code == 422


def test_purchase_without_an_item_is_rejected(client: TestClient, db_session: Session) -> None:
    owner(client, db_session)

    response = client.post(INVOICE_URL, json={})

    assert response.status_code == 422


def test_unknown_field_is_still_rejected(client: TestClient, db_session: Session) -> None:
    """`extra="forbid"` остался: опечатка в имени поля — ошибка ввода."""
    owner(client, db_session)
    solution = add_solution(db_session)

    response = client.post(INVOICE_URL, json={"solution_ids": solution.id})

    assert response.status_code == 422


def test_solution_invoice_shows_the_item_in_the_documents_list(
    client: TestClient, db_session: Session
) -> None:
    """Раздел «Документы» показывает название решения в столбце предмета."""
    owner(client, db_session)
    solution = add_solution(db_session)
    invoice_id = int(purchase_solution(client, solution.id).json()["id"])

    listed = client.get(INVOICE_URL).json()[0]

    assert listed["id"] == invoice_id
    assert listed["item_kind"] == "solution"
    assert listed["tariff_name"] == "Уведомления в Telegram"
