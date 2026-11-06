"""Счета организации: покупка, статусы и печатные формы (issue #49, #61, #99).

Критерии готовности разложены по блокам:

* покупка заводит счёт со снимком реквизитов покупателя и предмета, номер вида
  `СЧ-<год>-<id>`, статус «Новый» и подписи от сервера;
* повторный клик не плодит счета: живой `new` **за тот же предмет** возвращается
  как `200`;
* пустые название и ИНН, незнакомый тариф, чужая роль и чужой счёт дают разные
  коды: `409`, `404`, `403` и `404`;
* `new → paid` записывает организации оплаченный период тарифа и создаёт акт,
  `paid → closed` разрешён, `cancelled → paid` — `409`;
* **продление (#99):** вторая покупка при живом тарифе заполняет будущий слот,
  начало которого ровно равно `tariff_ends_at` текущего, а третья покупка до
  наступления будущего — `409` «Тариф уже оплачен на будущий период», и этот же
  `409` ждёт оплату счёта, если слоты заняли за время его жизни;
* счёт за решение (#61) покупается тем же путём, оплата выдаёт право и **не
  трогает** подписку, а счета за тариф и за решение не мешают друг другу;
* тариф без отметки оферты не покупается (#86): пропущенное поле и `false` дают
  `422` с текстом «Отметьте согласие с условиями оферты», а успешная покупка
  пишет в строку счёта момент, код `offer`, редакцию `documents.updated_at` и
  автора акцепта; повторный клик записанный акцепт не перезаписывает, но
  дозаписывает пустой; решения по-прежнему покупаются без отметки;
* **места (#168):** отдельный предмет счёта `seats` — сумма считается сервером
  как цена места × количество, строкой каталога `extra_member`; покупаются только
  сверх живого небезлимитного тарифа, отказы дословны, дедупликация идёт по
  количеству, а оплата растит `organizations.extra_seats`, не трогая подписку —
  после неё приглашение сверх прежнего предела проходит;
* оба файла — PDF, отдаются вложением и содержат название, ИНН и сумму; акт до
  оплаты — `404`.

Тесты идут на SQLite: `SELECT … FOR UPDATE` там вырождается в no-op, поэтому
блокировки проверяются чтением итогового состояния, а не параллельными запросами.
"""

import io
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from pypdf import PdfReader
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import billing_forms, solutions
from app.api.billing import SOLUTION_NOT_FOUND_DETAIL
from app.billing_forms import EMPTY_VALUE
from app.invoice_status import INVOICE_STATUS_LABELS, is_allowed, status_label
from app.models.company_details import SINGLE_ROW_ID, CompanyDetails
from app.models.document import Document
from app.models.invoice import Invoice, InvoiceDocument
from app.models.organization import Organization
from app.models.solution import OrganizationSolution, Solution
from app.models.tariff import Tariff
from app.offer import OFFER_ACCEPTANCE_REQUIRED_DETAIL, OFFER_DOCUMENT_CODE
from app.pricing import format_amount, format_invoice_amount
from app.schemas.invoice import SOLUTION_ALONE_MESSAGE
from app.seats import (
    EXTRA_MEMBER_CODE,
    MAX_SEATS_PER_PURCHASE,
    SEATS_NOT_FOR_SALE_DETAIL,
    SEATS_REQUIRE_TARIFF_DETAIL,
    SEATS_UNLIMITED_TARIFF_DETAIL,
)
from app.subscription import (
    MEMBER_LIMIT_HEADER,
    MEMBER_LIMIT_HEADER_VALUE,
    TARIFF_ALREADY_BOUGHT_DETAIL,
)
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
    max_members: int | None = None,
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
        max_members=max_members,
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
    """POST покупки тарифа. Возвращает ответ целиком: тесты смотрят и код, и тело.

    Отметка оферты едет всегда: без неё тарифный счёт не выставляется, и хелпер
    повторяет то, что делает форма. Тесты на сам отказ шлют тело руками — иначе
    отсутствие отметки осталось бы непокрытым.
    """
    return client.post(INVOICE_URL, json={"tariff_id": tariff_id, "offer_accepted": True})


def purchase_solution(client: TestClient, solution_id: int) -> Response:
    """POST покупки решения: та же ручка, другое поле предмета."""
    return client.post(INVOICE_URL, json={"solution_id": solution_id})


def purchase_seats(client: TestClient, seats: int) -> Response:
    """POST покупки мест: третье поле предмета — количество, без суммы и оферты."""
    return client.post(INVOICE_URL, json={"seats": seats})


def purchase_id(client: TestClient, tariff_id: int) -> int:
    """Идентификатор успешно выставленного счёта: покупка обязана пройти."""
    response = purchase(client, tariff_id)
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def set_status(client: TestClient, invoice_id: int, value: str) -> Response:
    return client.patch(f"{INVOICE_URL}/{invoice_id}", json={"status": value})


def pay_tariff(client: TestClient, tariff_id: int) -> int:
    """Купить и сразу оплатить тариф. Возвращает номер оплаченного счёта."""
    invoice_id = purchase_id(client, tariff_id)
    paid = set_status(client, invoice_id, PAID)
    assert paid.status_code == 200, paid.text
    return invoice_id


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


def test_second_purchase_after_payment_fills_the_future_period(
    client: TestClient, db_session: Session
) -> None:
    """Живой тариф — не отказ: вторая покупка оплачивает будущий период."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)
    first_id = pay_tariff(client, tariff.id)
    db_session.refresh(organization)
    current_end = organization.tariff_ends_at
    assert current_end is not None

    response = purchase(client, tariff.id)

    assert response.status_code == 201, response.text
    assert response.json()["id"] != first_id
    assert len(invoices_of(db_session, organization.id)) == 2


def test_third_purchase_before_the_future_period_is_a_conflict(
    client: TestClient, db_session: Session
) -> None:
    """Третий тариф до наступления будущего не продаётся: оба слота заняты."""
    organization = owner(client, db_session)
    monthly = add_tariff(db_session, name="Старт")
    quarter = add_tariff(db_session, name="Квартал", amount="13200.00", period="quarter")
    yearly = add_tariff(db_session, name="Год", amount="47000.00", period="year")
    pay_tariff(client, monthly.id)
    pay_tariff(client, quarter.id)
    db_session.refresh(organization)
    assert organization.next_tariff_id == quarter.id

    response = purchase(client, yearly.id)

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == TARIFF_ALREADY_BOUGHT_DETAIL
    assert len(invoices_of(db_session, organization.id)) == 2


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


# --- 2a. Акцепт оферты --------------------------------------------------------


def add_offer_document(db_session: Session, updated_at: datetime | None = None) -> Document:
    """Строка `documents` с кодом `offer`: из неё берётся снимок редакции."""
    document = Document(
        code=OFFER_DOCUMENT_CODE,
        title="Оферта",
        body="Текст оферты.",
        position=5,
        **({"updated_at": updated_at} if updated_at is not None else {}),
    )
    db_session.add(document)
    db_session.commit()
    db_session.refresh(document)
    return document


def test_tariff_purchase_without_the_offer_mark_is_rejected(
    client: TestClient, db_session: Session
) -> None:
    """Отсутствие поля — не «согласие по умолчанию»: счёт не выставляется."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)

    response = client.post(INVOICE_URL, json={"tariff_id": tariff.id})

    assert response.status_code == 422
    assert OFFER_ACCEPTANCE_REQUIRED_DETAIL in response.text
    assert invoices_of(db_session, organization.id) == []


def test_tariff_purchase_with_false_offer_mark_is_rejected(
    client: TestClient, db_session: Session
) -> None:
    """Явный отказ — тот же `422` с тем же текстом, что и пропущенное поле."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)

    response = client.post(INVOICE_URL, json={"tariff_id": tariff.id, "offer_accepted": False})

    assert response.status_code == 422
    assert OFFER_ACCEPTANCE_REQUIRED_DETAIL in response.text
    assert invoices_of(db_session, organization.id) == []


def test_purchase_records_the_offer_acceptance_snapshot(
    client: TestClient, db_session: Session
) -> None:
    """В счёте оседают момент, код документа, редакция и автор акцепта."""
    revision = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
    document = add_offer_document(db_session, updated_at=revision)
    user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, user, name=BUYER_NAME, inn=BUYER_INN)
    tariff = add_tariff(db_session)

    response = purchase(client, tariff.id)

    assert response.status_code == 201, response.text
    stored = invoices_of(db_session, organization.id)
    assert len(stored) == 1
    invoice = stored[0]
    assert invoice.id == response.json()["id"]
    assert invoice.offer_accepted_at is not None
    # Снимок редакции — `documents.updated_at`, а не «сейчас».
    assert invoice.offer_document_updated_at is not None
    assert as_utc(invoice.offer_document_updated_at) == as_utc(document.updated_at)
    assert invoice.offer_document_code == OFFER_DOCUMENT_CODE
    assert invoice.offer_accepted_by == user.id


def test_purchase_without_the_offer_document_still_works(
    client: TestClient, db_session: Session
) -> None:
    """Пустой справочник документов не повод отказать: редакция остаётся `NULL`."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)

    response = purchase(client, tariff.id)

    assert response.status_code == 201, response.text
    invoice = invoices_of(db_session, organization.id)[0]
    assert invoice.offer_accepted_at is not None
    assert invoice.offer_document_code == OFFER_DOCUMENT_CODE
    assert invoice.offer_document_updated_at is None


def test_repeat_purchase_does_not_overwrite_the_recorded_acceptance(
    client: TestClient, db_session: Session
) -> None:
    """Доказательство «когда согласился» не едет вслед за повторным кликом."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)
    document = add_offer_document(db_session)
    invoice_id = purchase_id(client, tariff.id)
    stored = invoices_of(db_session, organization.id)[0]
    accepted_at = stored.offer_accepted_at
    assert accepted_at is not None
    # Оферту поправили после покупки: прежний снимок редакции не должен съехать.
    document.updated_at = datetime(2026, 9, 9, 9, 0, tzinfo=UTC)
    db_session.commit()

    second = purchase(client, tariff.id)

    assert second.status_code == 200, second.text
    assert second.json()["id"] == invoice_id
    db_session.refresh(stored)
    assert stored.offer_accepted_at is not None
    assert as_utc(stored.offer_accepted_at) == as_utc(accepted_at)
    assert stored.offer_document_updated_at is not None
    assert as_utc(stored.offer_document_updated_at) != as_utc(document.updated_at)


def test_repeat_purchase_fills_an_empty_acceptance(client: TestClient, db_session: Session) -> None:
    """Живой счёт без акцепта (выставлен до задачи) дозаписывается при клике."""
    user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, user, name=BUYER_NAME, inn=BUYER_INN)
    tariff = add_tariff(db_session)
    add_offer_document(db_session)
    invoice = add_invoice(db_session, organization, tariff)
    assert invoice.offer_accepted_at is None

    response = purchase(client, tariff.id)

    assert response.status_code == 200, response.text
    assert response.json()["id"] == invoice.id
    db_session.refresh(invoice)
    assert invoice.offer_accepted_at is not None
    assert invoice.offer_document_code == OFFER_DOCUMENT_CODE
    assert invoice.offer_accepted_by == user.id


def test_solution_purchase_needs_no_offer_mark(client: TestClient, db_session: Session) -> None:
    """Магазин улучшений не изменился: решения покупаются без отметки."""
    organization = owner(client, db_session)
    solution = add_solution(db_session)

    response = purchase_solution(client, solution.id)

    assert response.status_code == 201, response.text
    stored = invoices_of(db_session, organization.id)[0]
    assert stored.offer_accepted_at is None
    assert stored.offer_document_code is None
    assert stored.offer_accepted_by is None


# --- 3. Статусы ---------------------------------------------------------------


def test_paid_binds_the_tariff_and_creates_the_act(client: TestClient, db_session: Session) -> None:
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    before = datetime.now(UTC)

    response = set_status(client, invoice_id, PAID)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == PAID
    assert body["status_label"] == "Оплачен"
    assert body["paid_at"] is not None
    assert body["has_act"] is True

    db_session.refresh(organization)
    assert organization.tariff_id == tariff.id
    # Срок пошёл с момента оплаты: месяц вперёд, границы проверяются с запасом.
    assert organization.tariff_ends_at is not None
    ends_at = as_utc(organization.tariff_ends_at)
    assert before + timedelta(days=27) < ends_at < before + timedelta(days=32)
    assert len(acts_of(db_session, invoice_id)) == 1
    # Запись тарифа открывает кабинет: пробный режим доступа больше не действует.
    assert client.get("/api/tariffs/current").json()["tariff"]["id"] == tariff.id


def test_paid_quarter_runs_three_months(client: TestClient, db_session: Session) -> None:
    """Квартальный тариф: срок — три календарных месяца от оплаты."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session, name="Старт · 3 месяца", period="quarter")
    invoice_id = purchase_id(client, tariff.id)
    before = datetime.now(UTC)

    assert set_status(client, invoice_id, PAID).status_code == 200

    db_session.refresh(organization)
    assert organization.tariff_ends_at is not None
    ends_at = as_utc(organization.tariff_ends_at)
    assert before + timedelta(days=87) < ends_at < before + timedelta(days=93)


def test_future_period_starts_at_the_current_end(client: TestClient, db_session: Session) -> None:
    """Второй оплаченный период начинается ровно в конце первого, а не с оплаты."""
    organization = owner(client, db_session)
    monthly = add_tariff(db_session, name="Старт")
    quarter = add_tariff(db_session, name="Квартал", amount="13200.00", period="quarter")
    # Будущий год сохраняет период действующим при запуске в любую дату;
    # фиксированные месяц и день проверяют календарную арифметику.
    current_year = datetime.now(UTC).year + 1
    current_end = datetime(current_year, 11, 2, 12, 0, tzinfo=UTC)
    organization.tariff_id = monthly.id
    organization.tariff_ends_at = current_end
    db_session.commit()

    pay_tariff(client, quarter.id)

    db_session.refresh(organization)
    assert organization.tariff_id == monthly.id
    assert organization.tariff_ends_at is not None
    assert as_utc(organization.tariff_ends_at) == current_end
    assert organization.next_tariff_id == quarter.id
    assert organization.next_tariff_ends_at is not None
    assert as_utc(organization.next_tariff_ends_at) == datetime(
        current_year + 1, 2, 2, 12, 0, tzinfo=UTC
    )


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


def test_paid_refuses_when_both_slots_were_taken_meanwhile(
    client: TestClient, db_session: Session
) -> None:
    """Счёт жил, пока оплачивали другие периоды: оплатить его некуда — `409`."""
    organization = owner(client, db_session)
    current = add_tariff(db_session, name="Старт")
    future = add_tariff(db_session, name="Квартал", amount="13200.00", period="quarter")
    late = add_tariff(db_session, name="Год", amount="47000.00", period="year")
    late_invoice = purchase_id(client, late.id)
    pay_tariff(client, current.id)
    pay_tariff(client, future.id)
    db_session.refresh(organization)

    response = set_status(client, late_invoice, PAID)

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == TARIFF_ALREADY_BOUGHT_DETAIL
    assert acts_of(db_session, late_invoice) == []
    assert organization.tariff_id == current.id
    assert organization.next_tariff_id == future.id


def test_paid_does_not_postpone_an_indefinite_tariff(
    client: TestClient, db_session: Session
) -> None:
    """Бессрочный тариф продлить нечем: будущему периоду не от чего считаться."""
    organization = owner(client, db_session)
    indefinite = add_tariff(db_session, name="Бессрочный")
    organization.tariff_id = indefinite.id
    db_session.commit()
    tariff = add_tariff(db_session, name="Старт")
    invoice = add_invoice(db_session, organization, tariff)

    response = set_status(client, invoice.id, PAID)

    assert response.status_code == 409
    assert response.json()["detail"] == TARIFF_ALREADY_BOUGHT_DETAIL
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


def money(amount: Decimal) -> str:
    """Сумма позиции без окончания по периоду: «2 700 ₽», уже без неразрывного."""
    return f"{format_amount(amount)} ₽".replace(NBSP, " ")


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


def test_seats_invoice_file_shows_the_quantity(client: TestClient, db_session: Session) -> None:
    """Печатная форма счёта за места: количество, цена места и множитель (#177).

    Без цены места и множителя первичный документ показывал бы только
    «Дополнительные сотрудники» и «2 700 ₽ разово» — сверить платёж с числом
    мест и увидеть скидку ступени бухгалтерия клиента не смогла бы.
    """
    owner_with_tariff(client, db_session)
    add_seats_catalog(db_session)
    invoice_id = int(purchase_seats(client, 3).json()["id"])
    invoice = db_session.get(Invoice, invoice_id)
    assert invoice is not None
    assert invoice.quantity == 3

    text = pdf_text(client.get(f"{INVOICE_URL}/{invoice_id}/file").content)

    assert "Дополнительные места · 3 —" in text
    # 900 ₽ — цена места, три места — 2 700 ₽: оба числа стоят в строке позиции.
    assert f"{money(Decimal('2700.00'))} ({money(Decimal('900.00'))} × 3)" in text
    assert "Итого:" in text
    assert amount_text(invoice) in text


def test_tariff_invoice_file_has_no_quantity_row(client: TestClient, db_session: Session) -> None:
    """У тарифа количество неприменимо: в позиции его нет, а итог прежний."""
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    invoice = db_session.get(Invoice, invoice_id)
    assert invoice is not None
    assert invoice.quantity is None

    text = pdf_text(client.get(f"{INVOICE_URL}/{invoice_id}/file").content)

    assert "Количество" not in text
    assert f"Тариф «Старт» — {amount_text(invoice)}" in text
    assert amount_text(invoice) in text


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
        billing_forms.invoice_pdf(invoice, None)


# --- 5a. Реквизиты поставщика и строка про НДС (#179) --------------------------
#
# Блок «Поставщик» и строка про НДС приходят из таблицы `company_details`
# (`app/company_details.py`), которую правят в кабинете оператора. Схема
# юнит-тестов собирается из моделей, без миграций, поэтому засева в ней нет:
# `None` — это и есть «реквизитов пока нет», а печать в этом случае показывает
# заглушку. Тесты с заполненными реквизитами вставляют строку сами.


def add_company(db_session: Session, **fields: object) -> CompanyDetails:
    """Единственная строка реквизитов прямо в базе: засев миграции не выполняется."""
    row = CompanyDetails(id=SINGLE_ROW_ID, **fields)
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def supplier_text(client: TestClient, invoice_id: int) -> str:
    """Текст свежего счёта: файла ещё нет, форма собирается первым скачиванием."""
    response = client.get(f"{INVOICE_URL}/{invoice_id}/file")
    assert response.status_code == 200, response.text
    return pdf_text(response.content)


def test_invoice_prints_the_filled_supplier_details(
    client: TestClient, db_session: Session
) -> None:
    """Заполненные реквизиты печатаются строками вместо заглушки."""
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    add_company(
        db_session,
        name="ООО «Поставщик»",
        inn="7701111111",
        kpp="770101001",
        ogrn="1027700132195",
        address="г. Москва, ул. Поставщиков, д. 2",
        bank_name="ПАО «Банк поставщика»",
        bank_bic="044525225",
        bank_account="40702810100000000001",
        corr_account="30101810400000000225",
        signatory="Директор Петров П. П.",
        vat_note="НДС не облагается",
    )

    text = supplier_text(client, invoice_id)

    assert "ООО «Поставщик»" in text
    assert "7701111111" in text
    assert "770101001" in text
    assert "1027700132195" in text
    assert "г. Москва, ул. Поставщиков, д. 2" in text
    assert "ПАО «Банк поставщика»" in text
    assert "044525225" in text
    assert "40702810100000000001" in text
    assert "30101810400000000225" in text
    assert "Директор Петров П. П." in text
    # Заглушка не нужна: реквизиты есть.
    assert "данные поставщика будут заполнены позже" not in text


def test_invoice_prints_only_the_filled_supplier_fields(
    client: TestClient, db_session: Session
) -> None:
    """Пустые поля не печатаются и не добиваются прочерками.

    Прочерк вместо банка выглядел бы как реквизит, которого нет: в блоке
    поставщика `_value` не применяется, поэтому строк «Банк —», «БИК —» в
    документе не бывает.
    """
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    add_company(db_session, name="ООО «Поставщик»", inn="7701111111")

    text = supplier_text(client, invoice_id)

    assert "ООО «Поставщик»" in text
    assert "7701111111" in text
    assert "Банк" not in text
    assert "БИК" not in text
    assert "Расчётный счёт" not in text
    assert "Подписант" not in text
    assert "данные поставщика будут заполнены позже" not in text


def test_invoice_prints_the_placeholder_when_no_field_is_filled(
    client: TestClient, db_session: Session
) -> None:
    """Строка есть, но пустая: печатается та же заглушка, что и без строки."""
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    add_company(db_session)

    text = supplier_text(client, invoice_id)

    assert "данные поставщика будут заполнены позже" in text
    assert "Банк" not in text


def test_invoice_prints_the_vat_line_after_the_subject(
    client: TestClient, db_session: Session
) -> None:
    """Строка про НДС стоит сразу после раздела «Предмет», а не в шапке."""
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    add_company(db_session, vat_note="НДС не облагается")

    text = supplier_text(client, invoice_id)

    assert "НДС не облагается" in text
    assert text.index("Предмет") < text.index("НДС не облагается")


def test_invoice_has_no_vat_line_when_the_note_is_empty(
    client: TestClient, db_session: Session
) -> None:
    """Пустой `vat_note` — строки нет вовсе: слова «НДС» в документе не остаётся."""
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    add_company(db_session, name="ООО «Поставщик»", vat_note=None)

    text = supplier_text(client, invoice_id)

    assert "НДС" not in text
    # Реквизиты при этом печатаются: пустая строка про НДС не гасит блок.
    assert "ООО «Поставщик»" in text


def test_act_prints_the_same_supplier_block_and_vat_line(
    client: TestClient, db_session: Session
) -> None:
    """Акт берёт те же реквизиты и ту же строку про НДС, что и счёт."""
    owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice_id = purchase_id(client, tariff.id)
    add_company(
        db_session,
        name="ООО «Поставщик»",
        bank_name="ПАО «Банк поставщика»",
        bank_bic="044525225",
        vat_note="НДС не облагается",
    )
    set_status(client, invoice_id, PAID)

    response = client.get(f"{INVOICE_URL}/{invoice_id}/act-file")

    assert response.status_code == 200, response.text
    text = pdf_text(response.content)
    assert "ПАО «Банк поставщика»" in text
    assert "044525225" in text
    assert "НДС не облагается" in text
    assert text.index("Предмет") < text.index("НДС не облагается")


def test_the_logo_asset_is_present_and_sized() -> None:
    """Ассет знака лежит рядом с модулем и объявляет размер: без него PDF не собрать.

    `width` и `height` в корне SVG обязательны: `fpdf2` берёт из них размер при
    вставке. Сам знак проверяется глазами в готовом PDF — неподдерживаемые
    элементы SVG `fpdf2` рисует молча пусто, и подстрокой в файле это не ловится.
    """
    source = billing_forms.LOGO_PATH.read_text(encoding="utf-8")

    assert billing_forms.LOGO_PATH.is_file()
    assert 'viewBox="0 0 40 40"' in source
    assert 'width="40"' in source
    assert 'height="40"' in source


def test_missing_logo_fails_with_a_clear_message(monkeypatch: pytest.MonkeyPatch) -> None:
    """Без знака форма не собирается: молчаливый PDF без логотипа недопустим."""
    invoice = Invoice(number="СЧ-2026-1", amount=Decimal("10000.00"), currency="RUB")
    monkeypatch.setattr(billing_forms, "LOGO_PATH", Path("/nowhere/logo.svg"))

    with pytest.raises(RuntimeError, match=r"logo\.svg"):
        billing_forms.invoice_pdf(invoice, None)


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


# --- 8. Места сверх тарифа (#168) ---------------------------------------------

EXTRA_MEMBER_NAME = "Дополнительные сотрудники"
SEATS_PRICE = "900.00"


def add_seats_catalog(
    db_session: Session, *, amount: str = SEATS_PRICE, is_visible: bool = True
) -> Solution:
    """Строка каталога, по которой продаются места: тот же seed, что `0064_extra_seats`.

    Юнит-тесты собирают схему из моделей, seed каталога живёт в миграции, поэтому
    строку заводит тест — как `add_solution` у решений.
    """
    return add_solution(
        db_session,
        code=EXTRA_MEMBER_CODE,
        name=EXTRA_MEMBER_NAME,
        description=(
            "Каждый дополнительный сотрудник сверх мест тарифа. Место живёт вместе с подпиской."
        ),
        amount=amount,
        period="once",
        position=900,
        is_visible=is_visible,
    )


def owner_with_tariff(
    client: TestClient,
    db_session: Session,
    max_members: int | None = 15,
    name: str = "Рост",
) -> tuple[Organization, Tariff]:
    """Владелец с оплаченным тарифом: места покупаются только поверх живого тарифа."""
    organization = owner(client, db_session)
    tariff = add_tariff(db_session, name=name, max_members=max_members)
    pay_tariff(client, tariff.id)
    db_session.refresh(organization)
    return organization, tariff


def invite(client: TestClient, email: str) -> Response:
    """Приглашение сотрудника: единственный путь, который упирается в предел мест."""
    return client.post(
        "/api/organization/invitations",
        json={"email": email, "full_name": "Петров Пётр", "role": "manager"},
    )


def test_seats_catalog_row_is_not_sellable_as_a_solution(
    client: TestClient, db_session: Session
) -> None:
    """Строку мест нельзя купить полем `solution_id`: это платёж без товара.

    Строка видима (`is_visible = true`) — по ней магазин рисует карточку, — и
    путь покупки решения по `id` для неё открыт. Оплата такого счёта завела бы
    право на код `extra_member`, которого не читает ни одна ручка, а `extra_seats`
    не вырос бы: клиент заплатил 900 ₽ и не получил ничего. Ответ — как у
    несуществующего решения: подтверждать существование непродаваемой строки
    незачем, и это не мешает покупать места полем `seats`.
    """
    organization, _ = owner_with_tariff(client, db_session)
    seats_row = add_seats_catalog(db_session)
    assert seats_row.is_visible is True

    response = purchase_solution(client, seats_row.id)

    assert response.status_code == 404, response.text
    assert response.json()["detail"] == SOLUTION_NOT_FOUND_DETAIL
    assert not [i for i in invoices_of(db_session, organization.id) if i.item_kind == "seats"]
    assert solutions.owned_codes(db_session, organization.id) == set()


def test_seats_purchase_bills_the_price_times_the_quantity(
    client: TestClient, db_session: Session
) -> None:
    """Сумму считает сервер: `900 ₽ × 3 = 2 700 ₽`, клиент присылает только количество."""
    owner_with_tariff(client, db_session)
    add_seats_catalog(db_session)

    response = purchase_seats(client, 3)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["item_kind"] == "seats"
    assert body["quantity"] == 3
    assert body["amount"] == "2700.00"
    assert body["currency"] == "RUB"
    assert body["amount_label"] == f"2{NBSP}700 ₽ разово"
    assert body["tariff_name"] == EXTRA_MEMBER_NAME
    assert body["tariff_period"] == "once"
    assert body["status"] == "new"


def test_seats_purchase_of_a_single_seat_costs_one_price(
    client: TestClient, db_session: Session
) -> None:
    """Границы: одно место — полная цена, сто мест — со скидкой 50 % (#177).

    Скидка ступенчатая и действует на весь набор: со ста мест цена места
    упирается в половину, поэтому 900 ₽ превращаются в 450 ₽ каждое.
    """
    owner_with_tariff(client, db_session)
    add_seats_catalog(db_session)

    single = purchase_seats(client, 1)
    assert single.status_code == 201, single.text
    assert single.json()["amount"] == "900.00"

    hundred = purchase_seats(client, MAX_SEATS_PER_PURCHASE)
    assert hundred.status_code == 201, hundred.text
    assert hundred.json()["amount"] == "45000.00"


def test_seats_quantity_outside_the_allowed_range_is_rejected(
    client: TestClient, db_session: Session
) -> None:
    """`0` и `101` — `422`: схема не пускает количество вне 1…100."""
    owner_with_tariff(client, db_session)
    add_seats_catalog(db_session)

    assert purchase_seats(client, 0).status_code == 422
    assert purchase_seats(client, MAX_SEATS_PER_PURCHASE + 1).status_code == 422


def test_seats_purchase_without_a_live_tariff_is_a_conflict(
    client: TestClient, db_session: Session
) -> None:
    """Без оплаченного тарифа докупать не к чему: отказ дословный."""
    owner(client, db_session)
    add_seats_catalog(db_session)

    response = purchase_seats(client, 3)

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == SEATS_REQUIRE_TARIFF_DETAIL


def test_seats_purchase_on_an_unlimited_tariff_is_a_conflict(
    client: TestClient, db_session: Session
) -> None:
    """Безлимитный ярус: предела нет, место ничего не добавляет — `409`."""
    owner_with_tariff(client, db_session, max_members=None, name="Безлимит")
    add_seats_catalog(db_session)

    response = purchase_seats(client, 3)

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == SEATS_UNLIMITED_TARIFF_DETAIL


def test_seats_purchase_without_a_catalog_row_is_not_found(
    client: TestClient, db_session: Session
) -> None:
    """Строки каталога нет или она скрыта — продавать нечего: `404` дословно."""
    owner_with_tariff(client, db_session)

    missing = purchase_seats(client, 3)
    assert missing.status_code == 404, missing.text
    assert missing.json()["detail"] == SEATS_NOT_FOR_SALE_DETAIL

    add_seats_catalog(db_session, is_visible=False)
    hidden = purchase_seats(client, 3)
    assert hidden.status_code == 404, hidden.text
    assert hidden.json()["detail"] == SEATS_NOT_FOR_SALE_DETAIL


def test_seats_purchase_without_buyer_requisites_is_a_conflict(
    client: TestClient, db_session: Session
) -> None:
    """Счёт выставляется только организации с названием и ИНН — как у тарифа."""
    organization, _ = owner_with_tariff(client, db_session)
    organization.name = None
    db_session.commit()
    add_seats_catalog(db_session)

    response = purchase_seats(client, 3)

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == (
        "Заполните название и ИНН организации на странице «Организация»"
    )


def test_seats_purchase_with_a_second_item_is_rejected(
    client: TestClient, db_session: Session
) -> None:
    """Решение вместе с местами — `422`: решение покупается отдельным счётом."""
    owner_with_tariff(client, db_session)
    solution = add_solution(db_session)

    response = client.post(
        INVOICE_URL, json={"seats": 3, "solution_id": solution.id, "offer_accepted": False}
    )

    assert response.status_code == 422, response.text
    assert SOLUTION_ALONE_MESSAGE in response.text


def test_repeat_seats_purchase_deduplicates_by_the_quantity(
    client: TestClient, db_session: Session
) -> None:
    """Повторный клик на то же количество — `200` с тем же счётом, на другое — новый."""
    organization = owner_with_tariff(client, db_session)[0]
    add_seats_catalog(db_session)
    first = purchase_seats(client, 3)
    assert first.status_code == 201, first.text

    repeated = purchase_seats(client, 3)

    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["id"] == first.json()["id"]
    assert len(invoices_of(db_session, organization.id)) == 2  # тариф и одни места

    other = purchase_seats(client, 5)

    assert other.status_code == 201, other.text
    assert other.json()["id"] != first.json()["id"]
    assert other.json()["amount"] == "4500.00"


def test_paid_seats_grow_the_counter_and_keep_the_subscription(
    client: TestClient, db_session: Session
) -> None:
    """Оплата прибавляет места к `extra_seats` и подписку не трогает."""
    organization, tariff = owner_with_tariff(client, db_session)
    ends_at = as_utc(organization.tariff_ends_at) if organization.tariff_ends_at else None
    add_seats_catalog(db_session)
    invoice_id = int(purchase_seats(client, 3).json()["id"])

    response = set_status(client, invoice_id, PAID)

    assert response.status_code == 200, response.text
    db_session.refresh(organization)
    assert organization.extra_seats == 3
    # Подписка та же: место — доплата к тарифу, а не второй период.
    assert organization.tariff_id == tariff.id
    assert organization.tariff_ends_at is not None
    assert as_utc(organization.tariff_ends_at) == ends_at
    assert organization.next_tariff_id is None


def test_paid_seats_invoice_cannot_be_paid_twice(client: TestClient, db_session: Session) -> None:
    """Правила переходов не тронуты: второй `paid` — `409`, счётчик не удваивается."""
    organization, _ = owner_with_tariff(client, db_session)
    add_seats_catalog(db_session)
    invoice_id = int(purchase_seats(client, 2).json()["id"])
    assert set_status(client, invoice_id, PAID).status_code == 200

    second = set_status(client, invoice_id, PAID)

    assert second.status_code == 409
    assert second.json()["detail"] == INVALID_STATUS_DETAIL
    db_session.refresh(organization)
    assert organization.extra_seats == 2


def test_paid_seats_invoice_has_no_offer_acceptance(
    client: TestClient, db_session: Session
) -> None:
    """За места оферта не требуется — отметки в счёте нет, как у решения."""
    owner_with_tariff(client, db_session)
    add_seats_catalog(db_session)
    invoice_id = int(purchase_seats(client, 3).json()["id"])
    assert set_status(client, invoice_id, PAID).status_code == 200

    invoice = db_session.get(Invoice, invoice_id)

    assert invoice is not None
    assert invoice.offer_accepted_at is None
    assert invoice.offer_accepted_by is None


def test_bought_seats_raise_the_invitation_limit(client: TestClient, db_session: Session) -> None:
    """Сквозной шов: покупка → оплата → приглашение сверх прежнего предела.

    Тариф с двумя местами, докуплено три — предел становится 5: пять приглашений
    проходят, шестое получает `409` с дословным текстом и заголовком
    `X-Member-Limit`. Счётчик растёт оплатой, а не выставлением счёта: до оплаты
    тот же предел остаётся прежним.
    """
    owner_with_tariff(client, db_session, max_members=2, name="Старт")
    add_seats_catalog(db_session)
    invoice_id = int(purchase_seats(client, 3).json()["id"])

    # Счёт выставлен, но не оплачен: предел ещё 2, третье приглашение упирается.
    assert invite(client, "before0@example.com").status_code == 201
    assert invite(client, "before1@example.com").status_code == 201
    assert invite(client, "before2@example.com").status_code == 409

    assert set_status(client, invoice_id, PAID).status_code == 200

    assert invite(client, "after0@example.com").status_code == 201
    assert invite(client, "after1@example.com").status_code == 201
    assert invite(client, "after2@example.com").status_code == 201

    refused = invite(client, "after3@example.com")

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == "Достигнут предел мест (5)"
    assert refused.headers[MEMBER_LIMIT_HEADER] == MEMBER_LIMIT_HEADER_VALUE


def test_current_tariff_shows_the_limit_with_the_bought_seats(
    client: TestClient, db_session: Session
) -> None:
    """`GET /api/tariffs/current` отдаёт предел готовым числом и разбивку рядом."""
    owner_with_tariff(client, db_session, max_members=15, name="Рост")
    add_seats_catalog(db_session)
    invoice_id = int(purchase_seats(client, 3).json()["id"])
    assert set_status(client, invoice_id, PAID).status_code == 200

    body = client.get("/api/tariffs/current").json()

    assert body["tariff"]["max_members"] == 15
    assert body["extra_seats"] == 3
    assert body["member_limit"] == 18


# --- 9. Счёт за «тариф + места» (#177) ----------------------------------------

HALF_YEAR_NAME = "Домовой · 6 месяцев"
HALF_YEAR_PRICE = "60000.00"
# Цена места после `0065_license_prices`: база ступеней в этом блоке.
SEAT_PRICE = "1500.00"


def add_half_year_license(db_session: Session, max_members: int | None = 5) -> Tariff:
    """Лицензия на 6 месяцев из нового прайса: 60 000 ₽ и пять сотрудников."""
    return add_tariff(
        db_session,
        name=HALF_YEAR_NAME,
        amount=HALF_YEAR_PRICE,
        period="half_year",
        max_members=max_members,
    )


def purchase_with_seats(
    client: TestClient, tariff_id: int, seats: int, offer_accepted: bool = True
) -> Response:
    """POST покупки «тариф + места» — одна сделка, две позиции."""
    return client.post(
        INVOICE_URL,
        json={"tariff_id": tariff_id, "seats": seats, "offer_accepted": offer_accepted},
    )


def test_tariff_with_seats_is_one_invoice_with_two_positions(
    client: TestClient, db_session: Session
) -> None:
    """«Тариф + 5 мест» — один счёт на 67 500 ₽ с двумя позициями, а не два счёта.

    Это главный критерий задачи: у покупки один документ и один платёж, а из
    чего он сложился — видно по позициям.
    """
    organization = owner(client, db_session)
    tariff = add_half_year_license(db_session)
    add_seats_catalog(db_session, amount=SEAT_PRICE)

    response = purchase_with_seats(client, tariff.id, 5)

    assert response.status_code == 201, response.text
    assert len(invoices_of(db_session, organization.id)) == 1
    body = response.json()
    assert body["amount"] == "67500.00"
    # Вид предмета — вид первой позиции: снимок счёта остаётся тарифным.
    assert body["item_kind"] == "tariff"
    assert body["tariff_name"] == HALF_YEAR_NAME
    assert body["tariff_period"] == "half_year"
    assert body["quantity"] is None

    items = body["items"]
    assert len(items) == 2
    tariff_item, seats_item = items
    assert tariff_item == {
        "kind": "tariff",
        "name": HALF_YEAR_NAME,
        "period": "half_year",
        "quantity": None,
        "unit_amount": HALF_YEAR_PRICE,
        "amount": "60000.00",
    }
    assert seats_item == {
        "kind": "seats",
        "name": EXTRA_MEMBER_NAME,
        "period": "once",
        "quantity": 5,
        "unit_amount": SEAT_PRICE,
        "amount": "7500.00",
    }

    stored = db_session.get(Invoice, int(body["id"]))
    assert stored is not None
    assert len(stored.items) == 2
    assert sum(item.amount for item in stored.items) == stored.amount


def test_ten_seats_are_discounted_for_the_whole_set(
    client: TestClient, db_session: Session
) -> None:
    """Десять мест — 1 350 ₽ каждое, то есть 13 500 ₽, а не 15 000 ₽."""
    owner(client, db_session)
    tariff = add_half_year_license(db_session)
    add_seats_catalog(db_session, amount=SEAT_PRICE)

    response = purchase_with_seats(client, tariff.id, 10)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["amount"] == "73500.00"
    seats_item = body["items"][1]
    assert seats_item["unit_amount"] == "1350.00"
    assert seats_item["amount"] == "13500.00"


def test_tariff_with_seats_requires_the_offer_mark(client: TestClient, db_session: Session) -> None:
    """Отметка оферты нужна всей сделке: тариф в ней есть — `422`."""
    owner(client, db_session)
    tariff = add_half_year_license(db_session)
    add_seats_catalog(db_session, amount=SEAT_PRICE)

    response = purchase_with_seats(client, tariff.id, 5, offer_accepted=False)

    assert response.status_code == 422, response.text
    assert OFFER_ACCEPTANCE_REQUIRED_DETAIL in response.text


def test_repeat_purchase_of_the_same_set_returns_the_same_invoice(
    client: TestClient, db_session: Session
) -> None:
    """Повторный клик с тем же набором — `200` с тем же счётом, с другим — новый."""
    organization = owner(client, db_session)
    tariff = add_half_year_license(db_session)
    add_seats_catalog(db_session, amount=SEAT_PRICE)
    first = purchase_with_seats(client, tariff.id, 5)
    assert first.status_code == 201, first.text

    repeated = purchase_with_seats(client, tariff.id, 5)

    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["id"] == first.json()["id"]

    other = purchase_with_seats(client, tariff.id, 6)

    assert other.status_code == 201, other.text
    assert other.json()["id"] != first.json()["id"]
    assert len(invoices_of(db_session, organization.id)) == 2


def test_tariff_with_seats_on_taken_slots_is_a_conflict(
    client: TestClient, db_session: Session
) -> None:
    """Оба слота подписки заняты — тариф не продаётся, и места вместе с ним."""
    organization = owner(client, db_session)
    monthly = add_tariff(db_session, name="Старт", amount="4900.00")
    quarter = add_tariff(db_session, name="Квартал", amount="13200.00", period="quarter")
    year = add_half_year_license(db_session)
    add_seats_catalog(db_session, amount=SEAT_PRICE)
    pay_tariff(client, monthly.id)
    pay_tariff(client, quarter.id)

    response = purchase_with_seats(client, year.id, 5)

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == TARIFF_ALREADY_BOUGHT_DETAIL
    assert not [
        invoice for invoice in invoices_of(db_session, organization.id) if invoice.items[1:]
    ]


def test_tariff_with_seats_on_an_unlimited_tariff_is_a_conflict(
    client: TestClient, db_session: Session
) -> None:
    """У безлимитного тарифа предела нет: места ничего не добавляют — `409`."""
    owner(client, db_session)
    tariff = add_half_year_license(db_session, max_members=None)
    add_seats_catalog(db_session, amount=SEAT_PRICE)

    response = purchase_with_seats(client, tariff.id, 5)

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == SEATS_UNLIMITED_TARIFF_DETAIL


def test_tariff_with_seats_without_a_catalog_row_is_not_found(
    client: TestClient, db_session: Session
) -> None:
    """Строки каталога мест нет — продавать нечего, даже вместе с тарифом."""
    owner(client, db_session)
    tariff = add_half_year_license(db_session)

    response = purchase_with_seats(client, tariff.id, 5)

    assert response.status_code == 404, response.text
    assert response.json()["detail"] == SEATS_NOT_FOR_SALE_DETAIL


def test_paying_a_tariff_with_seats_applies_both_positions(
    client: TestClient, db_session: Session
) -> None:
    """Одна оплата записывает подписку и растит счётчик мест, затем предел — 10.

    Сквозной шов задачи: после оплаты `member_limit` = 5 (тариф) + 5 (места), и
    это число отдаёт сервер, а не складывает экран.
    """
    organization = owner(client, db_session)
    tariff = add_half_year_license(db_session, max_members=5)
    add_seats_catalog(db_session, amount=SEAT_PRICE)
    invoice_id = int(purchase_with_seats(client, tariff.id, 5).json()["id"])

    paid = set_status(client, invoice_id, PAID)

    assert paid.status_code == 200, paid.text
    db_session.refresh(organization)
    assert organization.tariff_id == tariff.id
    assert organization.tariff_ends_at is not None
    assert organization.extra_seats == 5
    # Акт по-прежнему один на счёт, а не на позицию.
    assert len(acts_of(db_session, invoice_id)) == 1

    body = client.get("/api/tariffs/current").json()

    assert body["tariff"]["id"] == tariff.id
    assert body["extra_seats"] == 5
    assert body["member_limit"] == 10


def test_every_invoice_amount_is_the_sum_of_its_positions(
    client: TestClient, db_session: Session
) -> None:
    """`invoices.amount` — каноническая сумма: расхождение с позициями — дефект."""
    organization = owner(client, db_session)
    tariff = add_half_year_license(db_session)
    add_seats_catalog(db_session, amount=SEAT_PRICE)
    solution = add_solution(db_session)
    purchase_with_seats(client, tariff.id, 5)
    purchase_seats(client, 12)
    purchase_solution(client, solution.id)

    for invoice in invoices_of(db_session, organization.id):
        assert invoice.items, invoice.id
        assert sum((item.amount for item in invoice.items), Decimal("0.00")) == invoice.amount


def test_a_seats_only_purchase_keeps_its_single_position(
    client: TestClient, db_session: Session
) -> None:
    """Докупка мест без тарифа — прежнее поведение: один счёт с одной позицией."""
    owner_with_tariff(client, db_session)
    add_seats_catalog(db_session, amount=SEAT_PRICE)

    body = purchase_seats(client, 3).json()

    assert body["item_kind"] == "seats"
    assert body["quantity"] == 3
    assert body["amount"] == "4500.00"
    assert len(body["items"]) == 1
    assert body["items"][0]["kind"] == "seats"
    assert body["items"][0]["unit_amount"] == "1500.00"


def test_a_solution_invoice_has_one_solution_position(
    client: TestClient, db_session: Session
) -> None:
    """Счёт за решение по-прежнему покупается и отдаёт одну позицию `solution`."""
    owner(client, db_session)
    solution = add_solution(db_session)

    body = purchase_solution(client, solution.id).json()

    assert body["item_kind"] == "solution"
    assert [item["kind"] for item in body["items"]] == ["solution"]
    assert body["items"][0]["name"] == solution.name
    assert body["items"][0]["amount"] == str(solution.amount)


def test_a_historical_invoice_without_positions_keeps_its_subject(
    client: TestClient, db_session: Session
) -> None:
    """Счёт без строк `invoice_items` читается одной позицией из своего снимка.

    Так выглядит счёт, до которого бэкфилл `0066_invoice_items` не дошёл или
    который завели мимо ручки покупки: список позиций не должен оказаться пустым.
    """
    organization = owner(client, db_session)
    tariff = add_tariff(db_session)
    invoice = add_invoice(db_session, organization, tariff)
    # Снимок предмета есть, а позиций нет: так выглядит счёт, заведённый мимо
    # ручки покупки или до бэкфилла `0066_invoice_items`.
    invoice.tariff_name = tariff.name
    invoice.tariff_period = tariff.period
    db_session.commit()

    listed = client.get(f"{INVOICE_URL}/{invoice.id}")

    assert listed.status_code == 200, listed.text
    items = listed.json()["items"]
    assert len(items) == 1
    assert items[0]["kind"] == "tariff"
    assert items[0]["name"] == tariff.name
    assert items[0]["period"] == tariff.period
    assert items[0]["quantity"] is None
    assert items[0]["amount"] == str(invoice.amount)
