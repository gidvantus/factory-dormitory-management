"""Платформенный контур кабинета оператора: счета всех организаций (issue #149).

Проверяется то, что видит кабинет оператора: сервисный токен в заголовке
`X-Operator-Token`, страница реестра счетов всех организаций с фильтрами по
статусу и по организации, оплата и отмена через тот же `change_status`, что у
кабинета клиента, и печатные формы счёта и акта.

Главные правила задачи:

* список показывает счета **всех** организаций и фильтруется сервером: статус —
  точным значением, `search` — подстрокой названия или ИНН без учёта регистра;
* `PATCH` не заводит своих правил: `new → paid` привязывает тариф и создаёт акт,
  `cancelled → paid` отвечает `409` с текстом `app/invoice_status.py`;
* `can_manage` в платформенном контуре всегда `true` — право даёт сервисный
  токен, ролей организации здесь нет;
* `404` и `409` — часть контракта: кабинет передаёт тексты дословно.

Тесты идут на SQLite. Кириллический регистр проверяется отдельным `dbtest` в
конце файла: `lower()` в SQLite знает только ASCII, а на стенде база —
PostgreSQL.
"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import quote
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app import db as db_module
from app.api.platform_invoices import _search_condition
from app.config import get_settings
from app.invoice_status import (
    ACT_KIND,
    INVALID_STATUS_DETAIL,
    INVOICE_NOT_FOUND_DETAIL,
)
from app.invoices import ACT_NOT_FOUND_DETAIL
from app.models.audit import AuditEvent
from app.models.invoice import SOLUTION_ITEM_KIND, Invoice, InvoiceDocument
from app.models.organization import Organization
from app.models.solution import OrganizationSolution
from app.models.tariff import Tariff
from app.pricing import format_invoice_amount
from app.security import INVALID_OPERATOR_TOKEN_DETAIL
from app.subscription import TARIFF_ALREADY_BOUGHT_DETAIL
from tests.conftest import add_solution

# Заведомо ненастоящий секрет: настоящий в тестах не нужен.
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}
WRONG_HEADERS = {"X-Operator-Token": "not-the-token"}
PLATFORM = "/api/platform/invoices"

# Поля контракта — ровно те, что в `PlatformInvoice`: ответ кабинета клиента
# плюс организация. Сверка набором, а не по одному: иначе лишнее поле
# (например `offer_*` или внутренний ключ файла) прошло бы незамеченным.
INVOICE_FIELDS = {
    "id",
    "number",
    "status",
    "status_label",
    "item_kind",
    # Количество мест (#168): у счёта за тариф и за решение `null`, у счёта за
    # места — число. Поле есть в контракте обоих кабинетов: `PlatformInvoice`
    # оператора повторяет его руками (`operator/backend/app/schemas.py`), и без
    # этой строки там пропало бы количество.
    "quantity",
    "amount",
    "currency",
    "amount_label",
    "tariff_name",
    "tariff_period",
    "buyer_name",
    "buyer_inn",
    "buyer_kpp",
    "buyer_ogrn",
    "buyer_address",
    "has_act",
    "can_manage",
    "paid_at",
    "created_at",
    # Позиции счёта (#177): список состава покупки. Поле добавилось в ответ
    # кабинета клиента, а `PlatformInvoice` наследует его целиком, поэтому реестр
    # оператора получает его тем же контрактом. Ручная копия модели в
    # `operator/backend` лишнее поле отбрасывает — панель не ломается.
    "items",
    "organization_id",
    "organization_name",
}


@pytest.fixture
def operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный секрет сервисного контура. Кеш настроек сбрасывается до и после.

    Значение выставляется жёстко, а не `setdefault`: на стенде эта же переменная
    приходит из compose, а тест проверяет контракт, а не настройку стенда.
    """
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


@pytest.fixture
def empty_operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Пустой секрет: платформенные ручки закрыты целиком."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", "")
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


def add_tariff(
    db_session: Session,
    name: str = "Старт",
    amount: str = "10000.00",
    period: str = "month",
) -> Tariff:
    """Строка прайса прямо в базе: у счёта она нужна только по `id`."""
    tariff = Tariff(
        name=name,
        description="До 10 пользователей",
        amount=Decimal(amount),
        currency="RUB",
        period=period,
        unit_label=None,
        position=1,
        is_visible=True,
    )
    db_session.add(tariff)
    db_session.commit()
    db_session.refresh(tariff)
    return tariff


def add_organization(
    db_session: Session,
    name: str | None = "ООО Ромашка",
    inn: str | None = "7701234567",
) -> Organization:
    """Организация прямо в базе: пользователь для счёта не нужен."""
    organization = Organization(name=name, inn=inn, kpp="770101001", ogrn="1027700132195")
    db_session.add(organization)
    db_session.commit()
    db_session.refresh(organization)
    return organization


def add_invoice(
    db_session: Session,
    organization: Organization,
    *,
    tariff: Tariff | None = None,
    status: str = "new",
    created_at: datetime | None = None,
    item_kind: str = "tariff",
    solution_id: int | None = None,
    tariff_name: str = "Старт",
    amount: str = "10000.00",
) -> Invoice:
    """Счёт прямо в базе: у платформенных ручек проверки покупки не участвуют."""
    invoice = Invoice(
        organization_id=organization.id,
        item_kind=item_kind,
        tariff_id=tariff.id if tariff is not None else None,
        solution_id=solution_id,
        number=f"pending-{uuid4().hex}",
        status=status,
        amount=Decimal(amount),
        currency="RUB",
        buyer_name=organization.name,
        buyer_inn=organization.inn,
        tariff_name=tariff_name,
        tariff_period="month",
        created_at=created_at if created_at is not None else datetime.now(UTC),
    )
    db_session.add(invoice)
    db_session.commit()
    db_session.refresh(invoice)
    # Номер счёта в проекте — `СЧ-<год>-<id>`; окончательный вид требует `id`.
    invoice.number = f"СЧ-2026-{invoice.id}"
    db_session.commit()
    db_session.refresh(invoice)
    return invoice


def events(db_session: Session) -> list[AuditEvent]:
    """Строки журнала в порядке появления."""
    db_session.expire_all()
    return list(db_session.scalars(select(AuditEvent).order_by(AuditEvent.id)))


def acts_of(db_session: Session, invoice_id: int) -> list[InvoiceDocument]:
    db_session.expire_all()
    return list(
        db_session.scalars(select(InvoiceDocument).where(InvoiceDocument.invoice_id == invoice_id))
    )


def ascii_filename(disposition: str) -> str:
    """ASCII-запасное имя из `filename=`: его понимают старые клиенты."""
    return disposition.split('filename="', 1)[1].split('"', 1)[0]


# --- Токен ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", PLATFORM),
        ("patch", f"{PLATFORM}/1"),
        ("get", f"{PLATFORM}/1/file"),
        ("get", f"{PLATFORM}/1/act-file"),
    ],
)
def test_every_route_is_closed_without_the_service_token(
    client: TestClient, operator_token: None, method: str, path: str
) -> None:
    """Сессия основного кабинета сервисный токен не заменяет."""
    response = client.request(method, path, json={"status": "paid"} if method == "patch" else None)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


@pytest.mark.parametrize(
    ("headers", "fixture_name"),
    [
        ({}, "operator_token"),
        (WRONG_HEADERS, "operator_token"),
        (OPERATOR_HEADERS, "empty_operator_token"),
    ],
)
def test_missing_wrong_and_empty_token_are_identical_refusals(
    client: TestClient,
    request: pytest.FixtureRequest,
    headers: dict[str, str],
    fixture_name: str,
) -> None:
    """Три отказа побайтово одинаковы: по ответу нельзя понять, чего не хватило."""
    request.getfixturevalue(fixture_name)

    response = client.get(PLATFORM, headers=headers)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


# --- Список -----------------------------------------------------------------


def test_list_returns_the_contract_fields_and_the_organizations(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Строка списка — ответ кабинета клиента плюс организация, которой счёт выставлен."""
    first = add_organization(db_session, name="ООО Ромашка", inn="7701234567")
    second = add_organization(db_session, name="ООО Лютик", inn="7809876543")
    older = add_invoice(
        db_session,
        first,
        tariff=add_tariff(db_session),
        created_at=datetime(2026, 11, 1, tzinfo=UTC),
    )
    newer = add_invoice(
        db_session,
        second,
        created_at=datetime(2026, 11, 2, tzinfo=UTC),
    )

    response = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 2
    # Свежие сверху: порядок — `created_at DESC, id DESC`.
    assert [item["id"] for item in body["items"]] == [newer.id, older.id]
    for item in body["items"]:
        assert set(item) == INVOICE_FIELDS
    mine = next(item for item in body["items"] if item["id"] == older.id)
    assert mine["organization_id"] == first.id
    assert mine["organization_name"] == "ООО Ромашка"
    # Подписи и сумма собираются сервером: кабинет их не пересчитывает.
    assert mine["amount"] == "10000.00"
    assert mine["amount_label"] == format_invoice_amount(
        older.amount, older.currency, older.tariff_period
    )
    assert mine["status_label"] == "Новый"
    # Право в платформенном контуре даёт сервисный токен, а не роль.
    assert mine["can_manage"] is True
    assert mine["has_act"] is False


def test_list_is_empty_on_an_empty_platform(client: TestClient, operator_token: None) -> None:
    response = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    assert response.json() == {"items": [], "total": 0}


def test_list_filters_by_status(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = add_organization(db_session)
    new_invoice = add_invoice(db_session, organization, status="new")
    paid_invoice = add_invoice(db_session, organization, status="paid")
    cancelled_invoice = add_invoice(db_session, organization, status="cancelled")

    new_body = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"status": "new"}).json()
    paid_body = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"status": "paid"}).json()

    assert [item["id"] for item in new_body["items"]] == [new_invoice.id]
    assert new_body["total"] == 1
    assert [item["id"] for item in paid_body["items"]] == [paid_invoice.id]
    # Отменённый счёт из фильтра не исчезает: он есть в общем списке.
    full = client.get(PLATFORM, headers=OPERATOR_HEADERS).json()
    assert cancelled_invoice.id in [item["id"] for item in full["items"]]


def test_search_finds_by_name_and_by_inn_without_case(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Подстрока названия или ИНН без учёта регистра.

    Регистр проверяется на латинице: `lower()` в SQLite знает только ASCII, и
    «ИВАНОВ» там не находится поиском «иванов». Кириллический регистр —
    поведение PostgreSQL, и его проверяет `dbtest` в конце файла.
    """
    by_name = add_organization(db_session, name="OOO Romashka", inn="1111111111")
    by_inn = add_organization(db_session, name="ООО Лютик", inn="7700123456")
    outsider = add_organization(db_session, name="ООО Василёк", inn="5555555555")
    for organization in (by_name, by_inn, outsider):
        add_invoice(db_session, organization)

    for search in ("roma", "ROMA"):
        body = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"search": search}).json()
        assert [item["organization_id"] for item in body["items"]] == [by_name.id]
        assert body["total"] == 1

    by_inn_body = client.get(
        PLATFORM, headers=OPERATOR_HEADERS, params={"search": "7700123"}
    ).json()
    assert [item["organization_id"] for item in by_inn_body["items"]] == [by_inn.id]


def test_search_percent_does_not_return_everything(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`search=%` — литерал, а не шаблон: иначе список отдал бы все счета платформы."""
    add_invoice(db_session, add_organization(db_session))

    for search in ("%", "_"):
        response = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"search": search})

        assert response.status_code == 200, response.text
        assert response.json() == {"items": [], "total": 0}


def test_search_by_percent_inside_a_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Экранирование не ломает поиск: `%` находится как обычный символ."""
    odd = add_organization(db_session, name="Скидка 50% Петров", inn="6666666666")
    add_invoice(db_session, odd)
    add_invoice(db_session, add_organization(db_session))

    body = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"search": "50%"}).json()

    assert [item["organization_id"] for item in body["items"]] == [odd.id]


def test_search_and_status_work_together(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    romashka = add_organization(db_session, name="ООО Ромашка", inn="7777777777")
    new_invoice = add_invoice(db_session, romashka, status="new")
    add_invoice(db_session, romashka, status="paid")

    body = client.get(
        PLATFORM,
        headers=OPERATOR_HEADERS,
        params={"search": "Ромашка", "status": "new"},
    ).json()

    assert [item["id"] for item in body["items"]] == [new_invoice.id]
    assert body["total"] == 1


def test_pages_do_not_repeat_or_skip_invoices(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = add_organization(db_session)
    for index in range(5):
        add_invoice(
            db_session,
            organization,
            created_at=datetime(2026, 11, 1, tzinfo=UTC) + timedelta(minutes=index),
        )

    full = client.get(PLATFORM, headers=OPERATOR_HEADERS).json()
    expected = [item["id"] for item in full["items"]]

    first = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"limit": 2, "offset": 0})
    second = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"limit": 2, "offset": 2})

    assert first.status_code == second.status_code == 200
    page_ids = [item["id"] for item in first.json()["items"]]
    page_ids += [item["id"] for item in second.json()["items"]]
    assert page_ids == expected[:4]
    assert len(set(page_ids)) == len(page_ids)
    # `total` не зависит от страницы: по нему фронт решает, есть ли ещё.
    assert first.json()["total"] == second.json()["total"] == 5


def test_limit_offset_search_and_status_bounds_are_validated(
    client: TestClient, operator_token: None
) -> None:
    for params in (
        {"limit": 0},
        {"limit": 101},
        {"offset": -1},
        {"search": "я" * 101},
        {"status": "bogus"},
    ):
        response = client.get(PLATFORM, headers=OPERATOR_HEADERS, params=params)

        assert response.status_code == 422, params


# --- Оплата и отмена --------------------------------------------------------


def test_paid_binds_the_tariff_and_creates_the_act(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`new → paid` из кабинета оператора — та же оплата, что из кабинета клиента."""
    organization = add_organization(db_session)
    tariff = add_tariff(db_session)
    invoice = add_invoice(db_session, organization, tariff=tariff)

    response = client.patch(
        f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "paid"}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == INVOICE_FIELDS
    assert body["status"] == "paid"
    assert body["status_label"] == "Оплачен"
    assert body["has_act"] is True
    assert body["paid_at"] is not None
    assert body["organization_id"] == organization.id
    assert body["organization_name"] == "ООО Ромашка"
    assert body["can_manage"] is True

    db_session.expire_all()
    refreshed = db_session.get(Invoice, invoice.id)
    assert refreshed is not None and refreshed.status == "paid" and refreshed.paid_at is not None
    assert [act.kind for act in acts_of(db_session, invoice.id)] == [ACT_KIND]
    paid_organization = db_session.get(Organization, organization.id)
    assert paid_organization is not None
    assert paid_organization.tariff_id == tariff.id
    assert paid_organization.tariff_ends_at is not None


def test_cancel_sets_the_status_and_creates_no_act(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization)

    response = client.patch(
        f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "cancelled"}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "cancelled"
    assert body["status_label"] == "Отменён"
    assert body["has_act"] is False
    assert acts_of(db_session, invoice.id) == []


def test_payment_grants_a_solution_right(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Оплата счёта за решение выдаёт право и не трогает подписку."""
    organization = add_organization(db_session)
    solution = add_solution(db_session)
    invoice = add_invoice(
        db_session,
        organization,
        item_kind=SOLUTION_ITEM_KIND,
        solution_id=solution.id,
        tariff_name=solution.name,
        amount="500.00",
    )

    response = client.patch(
        f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "paid"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "paid"
    db_session.expire_all()
    rights = list(db_session.scalars(select(OrganizationSolution)))
    assert [right.solution_id for right in rights] == [solution.id]
    refreshed_organization = db_session.get(Organization, organization.id)
    assert refreshed_organization is not None
    assert refreshed_organization.tariff_id is None


def test_a_cancelled_invoice_cannot_be_paid(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Текст `409` — часть контракта: кабинет передаёт его дословно."""
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization, status="cancelled")

    response = client.patch(
        f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "paid"}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": INVALID_STATUS_DETAIL}
    db_session.expire_all()
    refreshed = db_session.get(Invoice, invoice.id)
    assert refreshed is not None and refreshed.status == "cancelled"
    assert acts_of(db_session, invoice.id) == []


def test_a_paid_invoice_cannot_be_paid_twice(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization, status="paid")

    response = client.patch(
        f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "paid"}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": INVALID_STATUS_DETAIL}


def test_payment_is_refused_when_both_slots_are_taken(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Оплата из кабинета оператора подчиняется тому же правилу слотов, что и клиента.

    Счёт жил, пока оператор оплачивал другие периоды: платить его некуда, и
    отказ приходит из `app/subscription.py` текстом о занятых слотах.
    """
    organization = add_organization(db_session)
    current = add_tariff(db_session, name="Старт")
    future = add_tariff(db_session, name="Квартал", amount="13200.00", period="quarter")
    organization.tariff_id = current.id
    organization.tariff_ends_at = datetime.now(UTC) + timedelta(days=30)
    organization.next_tariff_id = future.id
    organization.next_tariff_ends_at = datetime.now(UTC) + timedelta(days=120)
    db_session.commit()
    invoice = add_invoice(db_session, organization, tariff=add_tariff(db_session, name="Год"))

    response = client.patch(
        f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "paid"}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": TARIFF_ALREADY_BOUGHT_DETAIL}
    db_session.expire_all()
    refreshed = db_session.get(Invoice, invoice.id)
    assert refreshed is not None and refreshed.status == "new"
    assert acts_of(db_session, invoice.id) == []


def test_an_unpaid_invoice_cannot_be_closed(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`new → closed` не разрешён: закрывают только оплаченный счёт."""
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization)

    response = client.patch(
        f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "closed"}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": INVALID_STATUS_DETAIL}


def test_unknown_invoice_is_not_found_on_every_route(
    client: TestClient, operator_token: None
) -> None:
    patch_response = client.patch(
        f"{PLATFORM}/999999", headers=OPERATOR_HEADERS, json={"status": "paid"}
    )
    file_response = client.get(f"{PLATFORM}/999999/file", headers=OPERATOR_HEADERS)
    act_response = client.get(f"{PLATFORM}/999999/act-file", headers=OPERATOR_HEADERS)

    assert patch_response.status_code == 404
    assert patch_response.json() == {"detail": INVOICE_NOT_FOUND_DETAIL}
    assert file_response.status_code == 404
    assert file_response.json() == {"detail": INVOICE_NOT_FOUND_DETAIL}
    assert act_response.status_code == 404
    assert act_response.json() == {"detail": INVOICE_NOT_FOUND_DETAIL}


def test_the_status_new_is_rejected_by_the_schema(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`new` не «переоткрывает» счёт: набор допустимых статусов держит схема."""
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization, status="cancelled")

    response = client.patch(
        f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "new"}
    )

    assert response.status_code == 422


def test_a_foreign_field_in_the_body_is_rejected(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization)

    response = client.patch(
        f"{PLATFORM}/{invoice.id}",
        headers=OPERATOR_HEADERS,
        json={"status": "paid", "amount": "1.00"},
    )

    assert response.status_code == 422
    db_session.expire_all()
    refreshed = db_session.get(Invoice, invoice.id)
    assert refreshed is not None and refreshed.status == "new"


def test_patch_leaves_a_security_row_in_the_journal(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Оплата из кабинета оператора — действие безопасности, а не `data`."""
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization)

    response = client.patch(
        f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "cancelled"}
    )
    assert response.status_code == 200, response.text

    row = events(db_session)[-1]
    assert row.kind == audit.KIND_SECURITY
    assert row.action == "patch_platform_invoices"
    assert row.path == "/api/platform/invoices/{invoice_id}"
    assert row.path_params == {"invoice_id": str(invoice.id)}
    # Оператор кабинета — не пользователь платформы: актора и организации у него нет.
    assert row.actor_id is None
    assert row.organization_id is None
    # Читаемое название действия есть: иначе журнал показывал бы голый код.
    assert audit.action_title(row.action) == "Оплатить или отменить счёт из кабинета оператора"


# --- Печатные формы ---------------------------------------------------------


def test_invoice_file_is_downloaded_as_a_pdf(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization, tariff=add_tariff(db_session))

    response = client.get(f"{PLATFORM}/{invoice.id}/file", headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert f"filename*=UTF-8''{quote(f'invoice-{invoice.number}.pdf')}" in disposition
    assert ascii_filename(disposition).endswith(".pdf")


def test_the_same_invoice_file_is_given_twice(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Форма собирается один раз: повторное скачивание отдаёт те же байты."""
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization, tariff=add_tariff(db_session))

    first = client.get(f"{PLATFORM}/{invoice.id}/file", headers=OPERATOR_HEADERS)
    second = client.get(f"{PLATFORM}/{invoice.id}/file", headers=OPERATOR_HEADERS)

    assert first.status_code == second.status_code == 200
    assert first.content == second.content


def test_act_file_is_not_found_before_payment(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Текст `404` — часть контракта: до оплаты акта нет."""
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization)

    response = client.get(f"{PLATFORM}/{invoice.id}/act-file", headers=OPERATOR_HEADERS)

    assert response.status_code == 404
    assert response.json() == {"detail": ACT_NOT_FOUND_DETAIL}


def test_act_file_is_downloaded_after_payment(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization, tariff=add_tariff(db_session))
    client.patch(f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "paid"})

    response = client.get(f"{PLATFORM}/{invoice.id}/act-file", headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")
    disposition = response.headers["content-disposition"]
    assert f"filename*=UTF-8''{quote(f'act-{invoice.number}.pdf')}" in disposition
    assert ascii_filename(disposition).endswith(".pdf")


def test_act_appears_in_the_list_after_payment(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`has_act` в строке списка — признак появившегося акта, а не догадка фронта."""
    organization = add_organization(db_session)
    invoice = add_invoice(db_session, organization, tariff=add_tariff(db_session))
    client.patch(f"{PLATFORM}/{invoice.id}", headers=OPERATOR_HEADERS, json={"status": "paid"})

    body = client.get(PLATFORM, headers=OPERATOR_HEADERS).json()

    assert body["items"][0]["has_act"] is True


# --- Проверка на настоящей PostgreSQL ---------------------------------------


@pytest.mark.dbtest
def test_search_matches_a_cyrillic_name_without_case() -> None:
    """Регистр кириллицы — поведение PostgreSQL, а не SQLite.

    Юнит-прогон идёт на SQLite, где `lower()` знает только ASCII: «РОМАШКА»
    там поиском «ромашка» не находится. На стенде база — PostgreSQL, и кабинет
    обязан находить организацию в любом регистре. Строка заводится и убирается
    здесь же: чужой реестр тест не трогает.
    """
    marker = str(uuid4())
    with db_module.SessionLocal() as db:
        organization = Organization(name=f"ООО Ромашка {marker}", inn=None)
        db.add(organization)
        db.commit()
        db.refresh(organization)
        try:
            for term in ("ромашка", "РОМАШКА", "рОмАшКа"):
                found = db.scalars(select(Organization.id).where(_search_condition(term))).all()
                assert organization.id in found
        finally:
            db.delete(organization)
            db.commit()
