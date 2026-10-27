"""Магазин улучшений: каталог решений, право организации и гейт платной функции.

Критерии готовности разложены по блокам:

* `entitlement_expiry` — чистая функция: календарные месяцы с усечением на конце
  месяца, `once` даёт бессрочное право;
* `has_solution`/`owned_codes` различают действующее, просроченное и бессрочное
  право, а право одной организации не видно другой;
* `grant` выдаёт право и **продлевает** его, не заводя вторую строку: база
  отсчёта — `max(сейчас, текущий срок)`;
* `GET /api/solutions` отвечает 401 без сессии, 403 без активации, 404 без
  организации и отдаёт каталог с ценой от сервера;
* ручки платной функции отвечают 403 «решение не подключено» без права и
  работают с ним, а проверка активации у них остаётся первой.

Тесты идут на SQLite: `SELECT … FOR UPDATE` там вырождается в no-op, поэтому
блокировки проверяются итоговым состоянием, а не параллельными запросами.
Строку каталога заводит тест (`add_solution`): seed живёт в миграции, которая на
`Base.metadata.create_all` не выполняется.
"""

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import solutions
from app.models.solution import OrganizationSolution
from app.solutions import SOLUTION_REQUIRED_DETAIL, TELEGRAM_NOTIFICATIONS, entitlement_expiry
from tests.conftest import (
    JOURNAL_CODE,
    TELEGRAM_NOTIFICATIONS_CODE,
    add_solution,
    create_user,
    give_solution,
    organizations_for,
    sign_in,
)

CATALOG_URL = "/api/solutions"
STATUS_URL = "/api/telegram/status"

# Подпись цены собирает сервер. Разряды разделяются неразрывным пробелом, но у
# 500 разрядов нет — здесь обычный пробел.
PRICE_LABEL = "500 ₽ в месяц"

# Журнал действий — второе решение каталога, 300 ₽ в месяц.
JOURNAL_PRICE_LABEL = "300 ₽ в месяц"


def as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: для сравнения считаем его UTC.

    Модуль права приводит даты тем же способом (`_as_utc`), а тесту помощник
    нужен там, где он сверяет прочитанный из базы срок со «сейчас».
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def rows_of(db_session: Session, organization_id: int) -> list[OrganizationSolution]:
    return list(
        db_session.scalars(
            select(OrganizationSolution)
            .where(OrganizationSolution.organization_id == organization_id)
            .order_by(OrganizationSolution.id)
        )
    )


# --- 1. Период права без HTTP --------------------------------------------------


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


def test_once_gives_a_perpetual_right() -> None:
    assert entitlement_expiry("once", datetime(2026, 10, 14, tzinfo=UTC)) is None


def test_naive_granted_at_is_read_as_utc() -> None:
    """SQLite отдаёт naive datetime: функция не должна падать на сравнении."""
    assert entitlement_expiry("month", datetime(2026, 10, 14, 12, 0)) == datetime(
        2026, 11, 14, 12, 0, tzinfo=UTC
    )


# --- 2. Право организации без HTTP ---------------------------------------------


def test_right_appears_only_after_a_grant(db_session: Session) -> None:
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = add_solution(db_session)

    assert not solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)
    assert solutions.owned_codes(db_session, organization.id) == set()

    solutions.grant(db_session, organization.id, solution, invoice_id=None)
    db_session.commit()

    assert solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)
    assert solutions.owned_codes(db_session, organization.id) == {TELEGRAM_NOTIFICATIONS_CODE}

    row = rows_of(db_session, organization.id)[0]
    assert row.granted_at is not None
    assert row.expires_at is not None
    assert as_utc(row.expires_at) == entitlement_expiry("month", as_utc(row.granted_at))


def test_right_is_granted_with_the_invoice_id(db_session: Session) -> None:
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = add_solution(db_session)

    solutions.grant(db_session, organization.id, solution, invoice_id=42)
    db_session.commit()

    assert rows_of(db_session, organization.id)[0].invoice_id == 42


def test_expired_right_is_not_owned(db_session: Session) -> None:
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    give_solution(db_session, organization, expires_at=datetime.now(UTC) - timedelta(minutes=1))

    assert not solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)
    assert solutions.owned_codes(db_session, organization.id) == set()


def test_once_right_never_expires(db_session: Session) -> None:
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    give_solution(db_session, organization, period="once")

    assert rows_of(db_session, organization.id)[0].expires_at is None
    assert solutions.has_solution(db_session, organization.id, TELEGRAM_NOTIFICATIONS)


def test_right_of_another_organization_is_not_visible(db_session: Session) -> None:
    first = create_user(db_session, email="first@example.com")
    first_organization, _ = organizations_for(db_session, first)
    second = create_user(db_session, email="second@example.com")
    second_organization, _ = organizations_for(db_session, second, inn="7701234568")
    give_solution(db_session, first_organization)

    assert solutions.has_solution(db_session, first_organization.id, TELEGRAM_NOTIFICATIONS)
    assert not solutions.has_solution(db_session, second_organization.id, TELEGRAM_NOTIFICATIONS)


def test_second_grant_renews_the_single_row(db_session: Session) -> None:
    """Продление правит ту же строку, а не заводит вторую."""
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = give_solution(db_session, organization)

    first_expiry = rows_of(db_session, organization.id)[0].expires_at
    assert first_expiry is not None

    # Вторая оплата того же решения: срок считается от прежнего конца, а не от
    # «сейчас» — неоплаченное время не сгорает.
    solutions.grant(db_session, organization.id, solution, invoice_id=None)
    db_session.commit()

    rows = rows_of(db_session, organization.id)
    assert len(rows) == 1
    assert rows[0].expires_at is not None
    assert as_utc(rows[0].expires_at) == entitlement_expiry("month", as_utc(first_expiry))


def test_grant_after_expiry_counts_from_now(db_session: Session) -> None:
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = give_solution(
        db_session, organization, expires_at=datetime.now(UTC) - timedelta(days=10)
    )

    solutions.grant(db_session, organization.id, solution, invoice_id=None)
    db_session.commit()

    rows = rows_of(db_session, organization.id)
    assert len(rows) == 1
    assert rows[0].expires_at is not None
    assert as_utc(rows[0].expires_at) > datetime.now(UTC) + timedelta(days=27)


def test_grant_of_once_keeps_the_right_perpetual(db_session: Session) -> None:
    owner_user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, owner_user)
    solution = give_solution(db_session, organization, period="once")

    solutions.grant(db_session, organization.id, solution, invoice_id=None)
    db_session.commit()

    rows = rows_of(db_session, organization.id)
    assert len(rows) == 1
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
    """Каталог отдаёт строку целиком: код, цена строкой и «не куплено».

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
        "period": "month",
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
        "period": "month",
        "price_label": JOURNAL_PRICE_LABEL,
        "is_owned": False,
        "expires_at": None,
    }


def test_catalog_marks_an_owned_solution_with_its_expiry(
    client: TestClient, db_session: Session
) -> None:
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_solution(db_session, organization)

    body = client.get(CATALOG_URL).json()["items"][0]

    assert body["is_owned"] is True
    assert body["expires_at"] is not None


def test_catalog_does_not_own_an_expired_solution(client: TestClient, db_session: Session) -> None:
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_solution(db_session, organization, expires_at=datetime.now(UTC) - timedelta(days=1))

    body = client.get(CATALOG_URL).json()["items"][0]

    assert body["is_owned"] is False
    assert body["expires_at"] is None


def test_catalog_owns_a_perpetual_solution_without_a_date(
    client: TestClient, db_session: Session
) -> None:
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_solution(db_session, organization, period="once")

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


def test_catalog_is_readable_by_a_role_without_edit_rights(
    client: TestClient, db_session: Session
) -> None:
    """Витрина, а не правка: смотрит любой участник организации."""
    manager = sign_in(client, db_session, email="manager@example.com")
    organizations_for(db_session, manager, role="manager")
    add_solution(db_session)

    assert client.get(CATALOG_URL).status_code == 200


# --- 4. Гейт платной функции ---------------------------------------------------


def test_paid_function_is_closed_without_the_right(client: TestClient, db_session: Session) -> None:
    owner_user = sign_in(client, db_session)
    organizations_for(db_session, owner_user)
    add_solution(db_session)

    response = client.get(STATUS_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == SOLUTION_REQUIRED_DETAIL


def test_paid_function_is_closed_for_an_expired_right(
    client: TestClient, db_session: Session
) -> None:
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_solution(db_session, organization, expires_at=datetime.now(UTC) - timedelta(minutes=1))

    response = client.get(STATUS_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == SOLUTION_REQUIRED_DETAIL


def test_paid_function_opens_with_the_right(client: TestClient, db_session: Session) -> None:
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_solution(db_session, organization)

    response = client.get(STATUS_URL)

    assert response.status_code == 200, response.text
    assert response.json()["connected"] is False


def test_gate_of_another_solution_does_not_open_the_paid_function(
    client: TestClient, db_session: Session
) -> None:
    """Право на другое решение — не право на уведомления."""
    owner_user = sign_in(client, db_session)
    organization, _ = organizations_for(db_session, owner_user)
    give_solution(db_session, organization, code="another_solution")

    assert client.get(STATUS_URL).status_code == 403


def test_gate_keeps_the_activation_check_first(client: TestClient, db_session: Session) -> None:
    """Неактивированный кабинет получает прежний 403 про активацию, а не про магазин."""
    user = sign_in(client, db_session, email="inactive@example.com", is_active=False)
    organizations_for(db_session, user)
    add_solution(db_session)

    response = client.get(STATUS_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == "Активируйте личный кабинет"


def test_gate_without_an_organization_asks_for_a_solution(
    client: TestClient, db_session: Session
) -> None:
    """Право принадлежит организации: без неё права нет."""
    sign_in(client, db_session)
    add_solution(db_session)

    response = client.get(STATUS_URL)

    assert response.status_code == 403
    assert response.json()["detail"] == SOLUTION_REQUIRED_DETAIL


def test_gate_is_documented_in_the_openapi_schema(client: TestClient) -> None:
    """403 у ручки объявлен двумя текстами: активация и решение."""
    schema = client.get("/openapi.json").json()
    description = schema["paths"][STATUS_URL]["get"]["responses"]["403"]["description"]

    assert SOLUTION_REQUIRED_DETAIL in description
    assert "Активируйте личный кабинет" in description
