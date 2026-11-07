"""Магазин улучшений: каталог решений и гейт платной функции по действующему тарифу.

Критерии готовности разложены по блокам:

* `entitlement_expiry` — чистая функция арифметики периодов. Она переехала в
  `app/subscription.py` (иначе `app.solutions` и `app.subscription` импортировали
  бы друг друга), поэтому здесь проверяется её новое место, а формулы прежние:
  календарные месяцы с усечением на конце месяца, `once` — бессрочный срок;
* `owned_codes`/`has_solution` спрашивают **тариф** организации: своего срока у
  права больше нет, поэтому истёкший тариф выключает право, а новая оплата тарифа
  возвращает его без повторной покупки;
* `grant` пишет `expires_at = NULL` и правит ту же строку при повторной выдаче;
* `GET /api/solutions` отвечает 401 без сессии, 403 без активации, 404 без
  организации, отдаёт `period = "once"`, цену «…разово», а `expires_at` — конец
  действующего тарифа у купленного решения;
* ручки платной функции отвечают 403 с текстом закрытого кабинета без тарифа,
  403 «решение не подключено» с тарифом без права и работают, когда есть оба, а
  проверка активации у них остаётся первой.

Тесты идут на SQLite: `SELECT … FOR UPDATE` там вырождается в no-op, поэтому
блокировки проверяются итоговым состоянием, а не параллельными запросами.
Строку каталога заводит тест (`add_solution`): seed живёт в миграции, которая на
`Base.metadata.create_all` не выполняется.
"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import solutions
from app.config import get_settings
from app.models.solution import OrganizationSolution
from app.solutions import SOLUTION_REQUIRED_DETAIL, TELEGRAM_NOTIFICATIONS
from app.subscription import entitlement_expiry
from app.trial import TRIAL_EXPIRED_DETAIL
from tests.conftest import (
    JOURNAL_CODE,
    TELEGRAM_NOTIFICATIONS_CODE,
    add_solution,
    create_user,
    give_solution,
    give_tariff,
    organizations_for,
    sign_in,
)

CATALOG_URL = "/api/solutions"
STATUS_URL = "/api/telegram/status"

# Платформенные ручки каталога (#188): правка `position` из кабинета оператора —
# это и есть второй конец шва «порядок витрины».
PLATFORM_CATALOG_URL = "/api/platform/solutions"
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}


@pytest.fixture
def operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный секрет сервисного контура. Кеш настроек сбрасывается до и после."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


# Подпись цены собирает сервер. Разряды разделяются неразрывным пробелом, но у
# 500 разрядов нет — здесь обычный пробел. Период подписи — всегда «разово»:
# своего срока у решения нет (`app/api/solutions.py`).
PRICE_LABEL = "500 ₽ разово"

# Журнал действий — второе решение каталога, 300 ₽ разово.
JOURNAL_PRICE_LABEL = "300 ₽ разово"

# Конец действующего тарифа, который видит тест: он же уезжает в `expires_at`.
TARIFF_ENDS_AT = datetime(2027, 6, 30, 21, 0, tzinfo=UTC)


def as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: для сравнения считаем его UTC.

    Модуль права приводит даты тем же способом (`app.subscription.as_utc`), а
    тесту помощник нужен там, где он сверяет прочитанный из базы срок со «сейчас».
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def parse_moment(value: str) -> datetime:
    """Момент из JSON: `Z` в конце `pydantic` не всегда пишет, поэтому меняем его."""
    return as_utc(datetime.fromisoformat(value.replace("Z", "+00:00")))


def rows_of(db_session: Session, organization_id: int) -> list[OrganizationSolution]:
    return list(
        db_session.scalars(
            select(OrganizationSolution)
            .where(OrganizationSolution.organization_id == organization_id)
            .order_by(OrganizationSolution.id)
        )
    )


# --- 1. Арифметика периодов без HTTP -------------------------------------------


def test_month_period_is_a_calendar_month() -> None:
    assert entitlement_expiry("month", datetime(2026, 10, 14, 12, 30, tzinfo=UTC)) == datetime(
        2026, 11, 14, 12, 30, tzinfo=UTC
    )


def test_month_period_is_truncated_at_the_end_of_the_month() -> None:
    """31 января плюс месяц — конец февраля, а не 3 марта."""
    assert entitlement_expiry("month", datetime(2026, 1, 31, 9, 0, tzinfo=UTC)) == datetime(
        2026, 2, 28, 9, 0, tzinfo=UTC
    )
    # Високосный год: то же правило даёт 29 февраля.
    assert entitlement_expiry("month", datetime(2028, 1, 31, 9, 0, tzinfo=UTC)) == datetime(
        2028, 2, 29, 9, 0, tzinfo=UTC
    )


def test_december_rolls_over_into_the_next_year() -> None:
    assert entitlement_expiry("month", datetime(2026, 12, 15, 8, 0, tzinfo=UTC)) == datetime(
        2027, 1, 15, 8, 0, tzinfo=UTC
    )


def test_half_year_and_year_add_calendar_months() -> None:
    moment = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)
    assert entitlement_expiry("half_year", moment) == datetime(2027, 4, 14, 12, 0, tzinfo=UTC)
    assert entitlement_expiry("year", moment) == datetime(2027, 10, 14, 12, 0, tzinfo=UTC)


def test_once_gives_a_perpetual_period() -> None:
    assert entitlement_expiry("once", datetime(2026, 10, 14, tzinfo=UTC)) is None


def test_naive_granted_at_is_read_as_utc() -> None:
    """SQLite отдаёт naive datetime: функция не должна падать на сравнении."""
    assert entitlement_expiry("month", datetime(2026, 10, 14, 12, 0)) == datetime(
        2026, 11, 14, 12, 0, tzinfo=UTC
    )


# --- 2. Право организации: действует по тарифу --------------------------------


def test_right_is_invisible_without_a_tariff(db_session: Session) -> None:
    """Купленное право без действующего тарифа не работает — правило задачи."""
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = give_solution(db_session, organization, with_tariff=False)

    assert rows_of(db_session, organization.id)[0].solution_id == solution.id
    assert not solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)
    assert solutions.owned_codes(db_session, organization.id) == set()


def test_right_appears_with_a_live_tariff(db_session: Session) -> None:
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization)
    give_solution(db_session, organization, with_tariff=False)

    assert solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)
    assert solutions.owned_codes(db_session, organization.id) == {TELEGRAM_NOTIFICATIONS_CODE}


def test_expired_tariff_hides_the_right(db_session: Session) -> None:
    """Кончился тариф — кончились услуги, хотя строка права осталась."""
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization, ends_at=datetime.now(UTC) - timedelta(minutes=1))
    give_solution(db_session, organization, with_tariff=False)

    assert not solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)
    assert len(rows_of(db_session, organization.id)) == 1


def test_new_tariff_payment_returns_the_right_without_a_second_purchase(
    db_session: Session,
) -> None:
    """После оплаты нового тарифа купленное право снова действует само."""
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization, ends_at=datetime.now(UTC) - timedelta(days=1))
    give_solution(db_session, organization, with_tariff=False)
    assert not solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)

    give_tariff(db_session, organization)

    assert solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)
    assert len(rows_of(db_session, organization.id)) == 1


def test_grant_writes_a_null_expiry(db_session: Session) -> None:
    """Собственного срока у права нет: `expires_at` пишется `NULL`."""
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = add_solution(db_session)

    solutions.grant(db_session, organization.id, solution, invoice_id=None)
    db_session.commit()

    row = rows_of(db_session, organization.id)[0]
    assert row.granted_at is not None
    assert row.expires_at is None


def test_right_is_granted_with_the_invoice_id(db_session: Session) -> None:
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = add_solution(db_session)

    solutions.grant(db_session, organization.id, solution, invoice_id=42)
    db_session.commit()

    assert rows_of(db_session, organization.id)[0].invoice_id == 42


def test_recorded_expiry_of_the_right_is_not_read(db_session: Session) -> None:
    """Старый срок в строке права ничего не решает: решает тариф.

    Именно на этом стоит миграция `0068_solutions_tariff_scope`: колонка осталась
    историей, и просроченное значение в ней право не выключает.

    Это же и названное продуктовое правило (#195, замечание Б2 ревью): купленное
    когда-либо решение действует при любом следующем тарифе, в том числе купленное
    ранее и уже истёкшее. Нормализующая миграция такие строки не удаляет —
    `organization_solutions.expires_at` остаётся историей оплаченных сроков, —
    поэтому разовая покупка переживает конец старого срока и возвращается вместе с
    новым тарифом.
    """
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization)
    give_solution(
        db_session,
        organization,
        with_tariff=False,
        expires_at=datetime.now(UTC) - timedelta(days=1),
    )

    assert solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)


def test_right_of_another_organization_is_not_visible(db_session: Session) -> None:
    first = create_user(db_session, email="first@example.com")
    first_organization, _ = organizations_for(db_session, first)
    second = create_user(db_session, email="second@example.com")
    second_organization, _ = organizations_for(db_session, second, inn="7701234568")
    solution = add_solution(db_session)
    give_tariff(db_session, first_organization)
    give_tariff(db_session, second_organization)
    solutions.grant(db_session, first_organization.id, solution, invoice_id=None)
    db_session.commit()

    assert solutions.has_solution(db_session, first_organization.id, TELEGRAM_NOTIFICATIONS)
    assert not solutions.has_solution(db_session, second_organization.id, TELEGRAM_NOTIFICATIONS)


def test_second_grant_keeps_the_single_row(db_session: Session) -> None:
    """Повторная выдача правит ту же строку, а не заводит вторую."""
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = give_solution(db_session, organization)
    first_invoice = rows_of(db_session, organization.id)[0].invoice_id

    solutions.grant(db_session, organization.id, solution, invoice_id=7)
    db_session.commit()

    rows = rows_of(db_session, organization.id)
    assert len(rows) == 1
    assert rows[0].invoice_id == 7
    assert first_invoice is None
    assert rows[0].expires_at is None


def test_a_second_row_for_the_same_pair_is_rejected_by_the_database(
    db_session: Session,
) -> None:
    """Уникальность пары «организация — решение» держит база, а не только код."""
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = give_solution(db_session, organization)

    db_session.add(
        OrganizationSolution(
            organization_id=organization.id,
            solution_id=solution.id,
            granted_at=datetime.now(UTC),
            expires_at=None,
        )
    )
    try:
        db_session.commit()
    except IntegrityError:
        db_session.rollback()
    else:  # pragma: no cover - уникальность обязана сработать
        raise AssertionError("вторая строка права на ту же пару прошла уникальность")

    assert len(rows_of(db_session, organization.id)) == 1


# --- 3. Каталог по HTTP --------------------------------------------------------


def test_catalog_requires_a_session(client: TestClient) -> None:
    assert client.get(CATALOG_URL).status_code == 401


def test_catalog_requires_an_activated_cabinet(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session, email="inactive@example.com", is_active=False)

    response = client.get(CATALOG_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == "Активируйте личный кабинет"


def test_catalog_without_an_organization_is_not_found(
    client: TestClient, db_session: Session
) -> None:
    # Организация не заводится: проверяется именно отказ без неё.
    sign_in(client, db_session, organization=False)

    assert client.get(CATALOG_URL).status_code == 404


def test_catalog_lists_the_solution_with_the_server_price(
    client: TestClient, db_session: Session
) -> None:
    """Каталог отдаёт строку целиком: код, цену строкой и «не куплено».

    Период в ответе — `once` у каждой строки, даже когда в базе лежит `month`:
    своего срока у решения больше нет, и каталог его не пересказывает.

    Строк в каталоге две — «Уведомления в Telegram» и «Журнал действий»: оба
    решения продаются отдельно, поэтому проверяются обе строки, их порядок по
    `position` и цена журнала.
    """
    owner_user = sign_in(client, db_session)
    organizations_for(db_session, owner_user)
    solution = add_solution(db_session)
    journal = add_solution(
        db_session,
        code=JOURNAL_CODE,
        description="Кто, когда и что изменил в кабинете",
        amount="300.00",
        position=2,
    )

    response = client.get(CATALOG_URL)

    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 2
    assert items[0] == {
        "id": solution.id,
        "code": TELEGRAM_NOTIFICATIONS_CODE,
        "name": "Уведомления в Telegram",
        "description": "Сообщения о событиях, которые вас касаются",
        "amount": "500.00",
        "currency": "RUB",
        "period": "once",
        "price_label": PRICE_LABEL,
        "is_owned": False,
        "expires_at": None,
    }
    assert items[1] == {
        "id": journal.id,
        "code": JOURNAL_CODE,
        "name": "Журнал действий",
        "description": "Кто, когда и что изменил в кабинете",
        "amount": "300.00",
        "currency": "RUB",
        "period": "once",
        "price_label": JOURNAL_PRICE_LABEL,
        "is_owned": False,
        "expires_at": None,
    }


def test_catalog_marks_an_owned_solution_with_the_tariff_end(
    client: TestClient, db_session: Session
) -> None:
    """У купленного решения `expires_at` — конец действующего тарифа."""
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization, ends_at=TARIFF_ENDS_AT)
    give_solution(db_session, organization, with_tariff=False)

    body = client.get(CATALOG_URL).json()["items"][0]

    assert body["is_owned"] is True
    assert parse_moment(body["expires_at"]) == TARIFF_ENDS_AT


def test_catalog_does_not_own_a_solution_on_an_expired_tariff(
    client: TestClient, db_session: Session
) -> None:
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization, ends_at=datetime.now(UTC) - timedelta(days=1))
    give_solution(db_session, organization, with_tariff=False)

    body = client.get(CATALOG_URL).json()["items"][0]

    assert body["is_owned"] is False
    assert body["expires_at"] is None


def test_catalog_owns_a_solution_on_an_indefinite_tariff_without_a_date(
    client: TestClient, db_session: Session
) -> None:
    """Бессрочный тариф: право есть, конца тарифа нет — `expires_at = null`."""
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization, ends_at=None)
    give_solution(db_session, organization, with_tariff=False)

    body = client.get(CATALOG_URL).json()["items"][0]

    assert body["is_owned"] is True
    assert body["expires_at"] is None


def test_hidden_solutions_are_not_listed(client: TestClient, db_session: Session) -> None:
    owner_user = sign_in(client, db_session)
    organizations_for(db_session, owner_user)
    add_solution(db_session, name="Видимое", position=1)
    add_solution(db_session, code="hidden_one", name="Скрытое", position=2, is_visible=False)

    items = client.get(CATALOG_URL).json()["items"]

    assert [item["name"] for item in items] == ["Видимое"]


def test_catalog_is_ordered_by_position(client: TestClient, db_session: Session) -> None:
    owner_user = sign_in(client, db_session)
    organizations_for(db_session, owner_user)
    add_solution(db_session, code="second_code", name="Второе", position=5)
    add_solution(db_session, code="first_code", name="Первое", position=1)

    items = client.get(CATALOG_URL).json()["items"]

    assert [item["code"] for item in items] == ["first_code", "second_code"]


def test_editing_position_changes_the_catalog_order(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Правка `position` в кабинете оператора меняет порядок витрины магазина (#188).

    Порядок карточек `/cabinet/shop` — это порядок ответа `GET /api/solutions`
    (`position`, затем `id`): фронтенд его не пересортировывает. Здесь проверяется
    шов между половинами — админка меняет число, витрина едет за ним.
    """
    owner_user = sign_in(client, db_session)
    organizations_for(db_session, owner_user)
    add_solution(db_session, code="first_code", name="Первое", position=1)
    second = add_solution(db_session, code="second_code", name="Второе", position=5)

    response = client.patch(
        f"{PLATFORM_CATALOG_URL}/{second.id}", headers=OPERATOR_HEADERS, json={"position": 0}
    )

    assert response.status_code == 200, response.text
    items = client.get(CATALOG_URL).json()["items"]
    assert [item["code"] for item in items] == ["second_code", "first_code"]


def test_equal_positions_put_the_smaller_id_first(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Ничья по `position` решается `id`: это контракт порядка, а не дефект.

    Одинаковые `position` разрешены (колонка без `UNIQUE`), поэтому админка может
    выставить двум строкам одно число. Витрина показывает ту, что заведена раньше.
    """
    owner_user = sign_in(client, db_session)
    organizations_for(db_session, owner_user)
    add_solution(db_session, code="first_code", name="Первое", position=1)
    second = add_solution(db_session, code="second_code", name="Второе", position=5)

    response = client.patch(
        f"{PLATFORM_CATALOG_URL}/{second.id}", headers=OPERATOR_HEADERS, json={"position": 1}
    )

    assert response.status_code == 200, response.text
    items = client.get(CATALOG_URL).json()["items"]
    assert [item["code"] for item in items] == ["first_code", "second_code"]


def test_catalog_is_readable_by_a_role_without_edit_rights(
    client: TestClient, db_session: Session
) -> None:
    """Витрина, а не правка: смотрит любой участник организации."""
    manager = sign_in(client, db_session, email="manager@example.com")
    organizations_for(db_session, manager, role="manager")
    add_solution(db_session)

    assert client.get(CATALOG_URL).status_code == 200


# --- 4. Гейт платной функции ---------------------------------------------------


def test_paid_function_is_closed_without_a_tariff(client: TestClient, db_session: Session) -> None:
    """Без тарифа ручка отвечает текстом закрытого кабинета, а не магазина."""
    owner_user = sign_in(client, db_session)
    organizations_for(db_session, owner_user)
    add_solution(db_session)

    response = client.get(STATUS_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == TRIAL_EXPIRED_DETAIL


def test_paid_function_is_closed_on_an_expired_tariff(
    client: TestClient, db_session: Session
) -> None:
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization, ends_at=datetime.now(UTC) - timedelta(minutes=1))
    give_solution(db_session, organization, with_tariff=False)

    response = client.get(STATUS_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == TRIAL_EXPIRED_DETAIL


def test_paid_function_is_closed_with_a_tariff_but_without_the_right(
    client: TestClient, db_session: Session
) -> None:
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization)
    add_solution(db_session)

    response = client.get(STATUS_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == SOLUTION_REQUIRED_DETAIL


def test_paid_function_opens_with_the_tariff_and_the_right(
    client: TestClient, db_session: Session
) -> None:
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization)
    give_solution(db_session, organization, with_tariff=False)

    response = client.get(STATUS_URL)

    assert response.status_code == 200, response.text
    assert response.json()["connected"] is False


def test_gate_of_another_solution_does_not_open_the_paid_function(
    client: TestClient, db_session: Session
) -> None:
    """Право на другое решение — не право на уведомления."""
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_tariff(db_session, organization)
    give_solution(db_session, organization, code="another_solution", with_tariff=False)

    assert client.get(STATUS_URL).status_code == 403


def test_gate_keeps_the_activation_check_first(client: TestClient, db_session: Session) -> None:
    """Неактивированный кабинет получает прежний 403 про активацию, а не про магазин."""
    user = sign_in(client, db_session, email="inactive@example.com", is_active=False)
    organizations_for(db_session, user)
    add_solution(db_session)

    response = client.get(STATUS_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == "Активируйте личный кабинет"


def test_gate_without_an_organization_asks_for_a_tariff(
    client: TestClient, db_session: Session
) -> None:
    """Тариф и право принадлежат организации: без неё действующего тарифа нет."""
    sign_in(client, db_session)
    add_solution(db_session)

    response = client.get(STATUS_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == TRIAL_EXPIRED_DETAIL


def test_gate_is_documented_in_the_openapi_schema(client: TestClient) -> None:
    """403 у ручки объявлен тремя текстами: активация, тариф и решение."""
    schema = client.get("/openapi.json").json()
    description = schema["paths"][STATUS_URL]["get"]["responses"]["403"]["description"]

    assert "Активируйте личный кабинет" in description
    assert TRIAL_EXPIRED_DETAIL in description
    assert SOLUTION_REQUIRED_DETAIL in description
