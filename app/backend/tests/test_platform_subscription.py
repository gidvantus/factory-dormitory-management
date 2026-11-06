"""Платформенный контур: тариф и расширения организации в карточке оператора (#189).

Проверяется контракт из постановки — то, что видит кабинет оператора и на что
опирается фронтенд:

* без сервисного токена все четыре ручки закрыты (`401`), cookie клиентского
  кабинета контур не открывает — это закреплено в `tests/test_platform_organizations.py`;
* слоты читаются **по колонкам**: истёкший текущий виден как истёкший, даже когда
  уже оплачен следующий, — «виртуального переезда» (`organization_slots`) здесь нет;
* `paid_until` — последний включённый день по Москве, `days_left` — сутки вверх,
  `is_live` — по сроку, `price_label` — от `format_price`, `member_limit` —
  `max_members` плюс докупленные места;
* `PATCH` меняет **только** `tariff_ends_at`, `POST` снятия — только срок, и ни один
  из них не трогает `next_*`;
* снятие расширения пишет `expires_at = сейчас`, строка права остаётся в ответе с
  `is_live = false`; неизвестный `code` — `404 «Расширение не найдено»`;
* повторное снятие активности — `200`, а не отказ;
* тексты `422` приходят из валидатора схемы по-русски, лишнее поле — `422`;
* у трёх write-действий в журнале читаемое название из `ACTION_TITLES`, а не код.

Тесты герметичны: SQLite в памяти (см. `tests/conftest.py`), сеть не нужна.
"""

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit, subscription
from app import solutions as solutions_module
from app.api.organization import ORGANIZATION_NOT_FOUND_DETAIL
from app.api.platform_subscription import SOLUTION_NOT_FOUND_DETAIL
from app.config import get_settings
from app.models.audit import AuditEvent
from app.models.organization import Organization
from app.models.solution import OrganizationSolution
from app.models.tariff import Tariff
from app.schemas.platform_subscription import PAID_UNTIL_FORMAT_MESSAGE
from app.security import INVALID_OPERATOR_TOKEN_DETAIL
from tests.conftest import (
    JOURNAL_CODE,
    TELEGRAM_NOTIFICATIONS_CODE,
    add_solution,
    create_user,
    give_solution,
    login,
    organizations_for,
)

# Заведомо ненастоящий секрет: настоящий в тестах не нужен.
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}
WRONG_HEADERS = {"X-Operator-Token": "not-the-token"}
PLATFORM = "/api/platform/organizations"

MOSCOW = ZoneInfo("Europe/Moscow")

# Читаемые названия действий: их сверяет и тестировщик, и этот файл.
PATCH_TITLE = "Изменить срок действия тарифа организации"
DEACTIVATE_TITLE = "Снять активность тарифа организации"
SOLUTION_TITLE = "Снять активность расширения организации"

# Подпись цены собирает сервер (`app.pricing.format_price`). Разделитель разрядов
# в ней — неразрывный пробел (`\u00a0`), а не обычный.
PRICE_LABEL = "10\u00a0000 \u20bd в год"


@pytest.fixture
def operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный секрет сервисного контура. Кеш настроек сбрасывается до и после."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


def make_organization(db_session: Session, *, extra_seats: int = 0) -> tuple[Organization, str]:
    """Организация с владельцем — тем же помощником, что и остальные тесты.

    Возвращается и email владельца: тестам шва он нужен, чтобы войти в клиентский
    кабинет и сверить, что его чтение тарифа не изменилось.
    """
    email = "owner@example.com"
    user = create_user(db_session, email=email)
    organization, _ = organizations_for(db_session, user)
    organization.extra_seats = extra_seats
    db_session.commit()
    return organization, email


def add_tariff(
    db_session: Session,
    *,
    name: str = "Домовой · 12 месяцев",
    period: str = "year",
    max_members: int | None = 5,
) -> Tariff:
    """Строка прайса прямо в базе: подписке нужна только она."""
    tariff = Tariff(
        name=name,
        description=None,
        amount=Decimal("10000.00"),
        currency="RUB",
        period=period,
        max_members=max_members,
        position=1,
        is_visible=True,
    )
    db_session.add(tariff)
    db_session.commit()
    db_session.refresh(tariff)
    return tariff


def end_of_day(day: date) -> datetime:
    """Момент `day 23:59:59.999999` по Москве — так срок пишет кабинет."""
    return datetime.combine(day, subscription.END_OF_DAY, tzinfo=MOSCOW)


def bind_slot(
    db_session: Session,
    organization: Organization,
    tariff: Tariff | None,
    ends_at: datetime | None,
) -> None:
    """Заполнить текущий слот подписки так, как его заполнила бы оплата."""
    organization.tariff_id = tariff.id if tariff is not None else None
    organization.tariff_ends_at = ends_at
    db_session.commit()


def bind_next_slot(
    db_session: Session,
    organization: Organization,
    tariff: Tariff | None,
    ends_at: datetime | None,
) -> None:
    """Заполнить оплаченный вперёд слот."""
    organization.next_tariff_id = tariff.id if tariff is not None else None
    organization.next_tariff_ends_at = ends_at
    db_session.commit()


def events(db_session: Session) -> list[AuditEvent]:
    """Строки журнала в порядке появления."""
    db_session.expire_all()
    return list(db_session.scalars(select(AuditEvent).order_by(AuditEvent.id)))


def stored_ends_at(db_session: Session, organization_id: int) -> datetime | None:
    """Срок текущего слота из базы — без значения, закешированного сессией."""
    db_session.expire_all()
    organization = db_session.get(Organization, organization_id)
    assert organization is not None
    return organization.tariff_ends_at


# --- Токен ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", f"{PLATFORM}/1/subscription", None),
        ("patch", f"{PLATFORM}/1/subscription", {"paid_until": "2027-06-30"}),
        ("post", f"{PLATFORM}/1/subscription/deactivate", None),
        ("post", f"{PLATFORM}/1/solutions/journal/deactivate", None),
    ],
)
def test_missing_token_is_unauthorized(
    client: TestClient,
    operator_token: None,
    method: str,
    path: str,
    payload: dict[str, str] | None,
) -> None:
    response = client.request(method, path, json=payload)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


def test_wrong_token_is_unauthorized(client: TestClient, operator_token: None) -> None:
    response = client.get(f"{PLATFORM}/1/subscription", headers=WRONG_HEADERS)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


# --- Организация не найдена -------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", f"{PLATFORM}/999/subscription", None),
        ("patch", f"{PLATFORM}/999/subscription", {"paid_until": "2027-06-30"}),
        ("post", f"{PLATFORM}/999/subscription/deactivate", None),
        ("post", f"{PLATFORM}/999/solutions/journal/deactivate", None),
    ],
)
def test_unknown_organization_is_not_found(
    client: TestClient,
    operator_token: None,
    method: str,
    path: str,
    payload: dict[str, str] | None,
) -> None:
    """Текст общий на весь API: его объявляет `load_organization`, а не эта ручка."""
    response = client.request(method, path, json=payload, headers=OPERATOR_HEADERS)

    assert response.status_code == 404
    assert response.json() == {"detail": ORGANIZATION_NOT_FOUND_DETAIL}


# --- Пустое состояние -------------------------------------------------------


def test_empty_subscription_has_no_tariff_and_no_rights(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization, _ = make_organization(db_session)

    response = client.get(f"{PLATFORM}/{organization.id}/subscription", headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "tariff": None,
        "days_left": 0,
        "next": None,
        "extra_seats": 0,
        "member_limit": None,
        "solutions": [],
    }


# --- Действующий тариф ------------------------------------------------------


def test_active_tariff_is_reported_with_moscow_paid_until(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Срок в ответе — и момент, и последний включённый день по Москве."""
    organization, _ = make_organization(db_session, extra_seats=3)
    tariff = add_tariff(db_session)
    ends_at = datetime.now(UTC) + timedelta(days=30)
    bind_slot(db_session, organization, tariff, ends_at)

    response = client.get(f"{PLATFORM}/{organization.id}/subscription", headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tariff"]["id"] == tariff.id
    assert body["tariff"]["name"] == "Домовой · 12 месяцев"
    assert body["tariff"]["period"] == "year"
    assert body["tariff"]["max_members"] == 5
    assert body["tariff"]["price_label"] == PRICE_LABEL
    assert body["tariff"]["is_live"] is True
    assert datetime.fromisoformat(body["tariff"]["ends_at"]) == ends_at
    # Последний включённый день — тот, что в Москве, а не в UTC.
    expected_paid_until = (ends_at - timedelta(microseconds=1)).astimezone(MOSCOW).date()
    assert body["tariff"]["paid_until"] == expected_paid_until.isoformat()
    # Тридцать суток, округлённые вверх: неполный день считается за полный.
    assert body["days_left"] == 30
    # Предел мест — тариф плюс докупленное, разбивка видна отдельно.
    assert body["extra_seats"] == 3
    assert body["member_limit"] == 8
    assert body["next"] is None


def test_indefinite_tariff_has_no_paid_until(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`tariff_ends_at IS NULL` — бессрочный тариф: ни дня, ни остатка."""
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session, period="once", max_members=None)
    bind_slot(db_session, organization, tariff, None)

    response = client.get(f"{PLATFORM}/{organization.id}/subscription", headers=OPERATOR_HEADERS)

    body = response.json()
    assert body["tariff"]["is_live"] is True
    assert body["tariff"]["ends_at"] is None
    assert body["tariff"]["paid_until"] is None
    assert body["days_left"] == 0
    # Безлимитный ярус места не ограничивает: предела по подписке нет.
    assert body["tariff"]["max_members"] is None
    assert body["member_limit"] is None


def test_expired_slot_is_shown_as_recorded(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Истёкший текущий слот виден истёкшим, даже когда оплачен следующий.

    Это и есть отличие чтения оператора от клиентского `GET /api/tariffs/current`:
    там действующим считается будущий тариф (виртуальный переезд), здесь —
    запись. Оба ответа сверяются в одном тесте, чтобы расхождение было видно.
    """
    organization, email = make_organization(db_session)
    current = add_tariff(db_session)
    upcoming = add_tariff(db_session, name="Домовой · 6 месяцев", period="half_year")
    bind_slot(db_session, organization, current, datetime.now(UTC) - timedelta(days=10))
    bind_next_slot(db_session, organization, upcoming, datetime.now(UTC) + timedelta(days=180))

    response = client.get(f"{PLATFORM}/{organization.id}/subscription", headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    # Запись: текущий слот истёк.
    assert body["tariff"]["id"] == current.id
    assert body["tariff"]["is_live"] is False
    assert body["days_left"] == 0
    # Оплаченный вперёд слот показан рядом и не выдан за текущий.
    assert body["next"]["tariff"]["id"] == upcoming.id
    assert body["next"]["paid_until"] is not None

    # Клиентский кабинет отвечает по-прежнему: действует оплаченный вперёд.
    login(client, email)
    client_side = client.get("/api/tariffs/current")
    assert client_side.status_code == 200, client_side.text
    assert client_side.json()["tariff"]["id"] == upcoming.id


# --- Правка срока -----------------------------------------------------------


def test_patch_writes_the_last_included_day_of_moscow(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session)
    bind_slot(db_session, organization, tariff, datetime.now(UTC) + timedelta(days=10))

    response = client.patch(
        f"{PLATFORM}/{organization.id}/subscription",
        headers=OPERATOR_HEADERS,
        json={"paid_until": "2027-06-30"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tariff"]["paid_until"] == "2027-06-30"
    assert body["tariff"]["is_live"] is True
    assert body["days_left"] > 0
    # В базу лёг конец московских суток — тот же момент, что и `23:59:59.999999 МСК`.
    assert subscription.as_utc(stored_ends_at(db_session, organization.id)) == end_of_day(
        date(2027, 6, 30)
    ).astimezone(UTC)


def test_patch_does_not_touch_the_paid_forward_slot(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization, _ = make_organization(db_session)
    current = add_tariff(db_session)
    upcoming = add_tariff(db_session, name="Домовой · 6 месяцев", period="half_year")
    next_ends_at = datetime.now(UTC) + timedelta(days=180)
    bind_slot(db_session, organization, current, datetime.now(UTC) + timedelta(days=10))
    bind_next_slot(db_session, organization, upcoming, next_ends_at)

    response = client.patch(
        f"{PLATFORM}/{organization.id}/subscription",
        headers=OPERATOR_HEADERS,
        json={"paid_until": "2027-06-30"},
    )

    assert response.status_code == 200, response.text
    db_session.expire_all()
    refreshed = db_session.get(Organization, organization.id)
    assert refreshed is not None
    assert refreshed.next_tariff_id == upcoming.id
    assert subscription.as_utc(refreshed.next_tariff_ends_at) == next_ends_at
    assert response.json()["next"]["tariff"]["id"] == upcoming.id


def test_patch_turns_an_indefinite_tariff_into_a_dated_one(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Бессрочный тариф получает срок: обратной дороги из кабинета нет."""
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session, period="once")
    bind_slot(db_session, organization, tariff, None)

    response = client.patch(
        f"{PLATFORM}/{organization.id}/subscription",
        headers=OPERATOR_HEADERS,
        json={"paid_until": "2027-06-30"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["tariff"]["paid_until"] == "2027-06-30"
    assert response.json()["tariff"]["is_live"] is True
    db_session.expire_all()
    refreshed = db_session.get(Organization, organization.id)
    assert refreshed is not None and refreshed.tariff_id == tariff.id


def test_patch_accepts_a_date_in_the_past_and_reports_an_expired_tariff(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Дата в прошлом — не отказ: это способ закрыть тариф, и ответ это скажет."""
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session)
    bind_slot(db_session, organization, tariff, datetime.now(UTC) + timedelta(days=10))

    response = client.patch(
        f"{PLATFORM}/{organization.id}/subscription",
        headers=OPERATOR_HEADERS,
        json={"paid_until": "2026-01-15"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tariff"]["paid_until"] == "2026-01-15"
    assert body["tariff"]["is_live"] is False
    assert body["days_left"] == 0


@pytest.mark.parametrize(
    "payload",
    [
        {"paid_until": "31.02.2027"},
        {"paid_until": ""},
        {"paid_until": None},
        {},
    ],
)
def test_patch_rejects_a_bad_date_with_the_russian_text(
    client: TestClient, db_session: Session, operator_token: None, payload: dict[str, object]
) -> None:
    """Отсутствие поля, `null`, пустая строка и мусор — один и тот же текст."""
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session)
    bind_slot(db_session, organization, tariff, None)

    response = client.patch(
        f"{PLATFORM}/{organization.id}/subscription", headers=OPERATOR_HEADERS, json=payload
    )

    assert response.status_code == 422
    messages = [error["msg"] for error in response.json()["detail"]]
    assert messages == [f"Value error, {PAID_UNTIL_FORMAT_MESSAGE}"]
    # Отказ ничего не записал: срок остался бессрочным.
    assert stored_ends_at(db_session, organization.id) is None


def test_patch_rejects_a_foreign_field(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Тело обещает одно поле: лишнее — `422`, а не молчаливое «проигнорировали»."""
    organization, _ = make_organization(db_session)

    response = client.patch(
        f"{PLATFORM}/{organization.id}/subscription",
        headers=OPERATOR_HEADERS,
        json={"paid_until": "2027-06-30", "tariff_id": 2},
    )

    assert response.status_code == 422
    assert stored_ends_at(db_session, organization.id) is None


# --- Снятие активности тарифа ----------------------------------------------


def test_deactivate_writes_the_current_moment(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session)
    bind_slot(db_session, organization, tariff, datetime.now(UTC) + timedelta(days=30))

    before = datetime.now(UTC)
    response = client.post(
        f"{PLATFORM}/{organization.id}/subscription/deactivate", headers=OPERATOR_HEADERS
    )
    after = datetime.now(UTC)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tariff"]["is_live"] is False
    assert body["days_left"] == 0
    # Ничего не удалено: строка тарифа на месте, срок — в прошлом.
    assert body["tariff"]["id"] == tariff.id
    stored = subscription.as_utc(stored_ends_at(db_session, organization.id))
    assert before - timedelta(seconds=2) <= stored <= after + timedelta(seconds=2)


def test_repeated_deactivation_is_not_a_failure(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Команда идемпотентна: второй вызов — `200` и то же «не действует»."""
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session)
    bind_slot(db_session, organization, tariff, datetime.now(UTC) + timedelta(days=30))
    path = f"{PLATFORM}/{organization.id}/subscription/deactivate"

    first = client.post(path, headers=OPERATOR_HEADERS)
    second = client.post(path, headers=OPERATOR_HEADERS)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["tariff"]["is_live"] is False
    assert second.json()["tariff"]["is_live"] is False
    assert first.json()["tariff"]["id"] == second.json()["tariff"]["id"] == tariff.id


def test_deactivation_does_not_touch_the_paid_forward_slot(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization, _ = make_organization(db_session)
    current = add_tariff(db_session)
    upcoming = add_tariff(db_session, name="Домовой · 6 месяцев", period="half_year")
    next_ends_at = datetime.now(UTC) + timedelta(days=180)
    bind_slot(db_session, organization, current, datetime.now(UTC) + timedelta(days=30))
    bind_next_slot(db_session, organization, upcoming, next_ends_at)

    response = client.post(
        f"{PLATFORM}/{organization.id}/subscription/deactivate", headers=OPERATOR_HEADERS
    )

    assert response.status_code == 200, response.text
    db_session.expire_all()
    refreshed = db_session.get(Organization, organization.id)
    assert refreshed is not None
    assert refreshed.next_tariff_id == upcoming.id
    assert subscription.as_utc(refreshed.next_tariff_ends_at) == next_ends_at


def test_deactivation_closes_the_client_cabinet(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Снятие тарифа — это срок: клиент видит истёкший тариф, а не пустую запись."""
    organization, email = make_organization(db_session)
    tariff = add_tariff(db_session)
    bind_slot(db_session, organization, tariff, datetime.now(UTC) + timedelta(days=30))

    client.post(f"{PLATFORM}/{organization.id}/subscription/deactivate", headers=OPERATOR_HEADERS)

    login(client, email)
    client_side = client.get("/api/tariffs/current")
    assert client_side.status_code == 200, client_side.text
    assert client_side.json()["tariff"] is None


# --- Расширения -------------------------------------------------------------


def test_rights_include_an_expired_one(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Истёкшее право остаётся в ответе с `is_live = false` — это история покупок."""
    organization, _ = make_organization(db_session)
    expired = give_solution(
        db_session,
        organization,
        code=TELEGRAM_NOTIFICATIONS_CODE,
        expires_at=datetime.now(UTC) - timedelta(days=5),
    )
    active = give_solution(db_session, organization, code=JOURNAL_CODE)

    response = client.get(f"{PLATFORM}/{organization.id}/subscription", headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    rights = response.json()["solutions"]
    assert [(right["code"], right["is_live"]) for right in rights] == [
        (expired.code, False),
        (active.code, True),
    ]
    assert rights[0]["name"] == "Уведомления в Telegram"
    assert rights[0]["paid_until"] is not None
    assert rights[1]["expires_at"] is not None


def test_deactivate_right_writes_the_current_moment_and_keeps_the_row(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization, _ = make_organization(db_session)
    solution = give_solution(db_session, organization, code=JOURNAL_CODE)

    before = datetime.now(UTC)
    response = client.post(
        f"{PLATFORM}/{organization.id}/solutions/{solution.code}/deactivate",
        headers=OPERATOR_HEADERS,
    )
    after = datetime.now(UTC)

    assert response.status_code == 200, response.text
    rights = response.json()["solutions"]
    assert len(rights) == 1
    assert rights[0]["code"] == solution.code
    assert rights[0]["is_live"] is False
    # Срок в прошлом, а не удаление строки.
    db_session.expire_all()
    row = db_session.scalar(
        select(OrganizationSolution).where(
            OrganizationSolution.organization_id == organization.id,
            OrganizationSolution.solution_id == solution.id,
        )
    )
    assert row is not None
    stored = subscription.as_utc(row.expires_at)
    assert before - timedelta(seconds=2) <= stored <= after + timedelta(seconds=2)
    # Платная функция организации права больше не видит.
    assert solutions_module.has_solution(db_session, organization.id, solution.code) is False


def test_deactivate_right_twice_is_not_a_failure(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization, _ = make_organization(db_session)
    solution = give_solution(db_session, organization, code=JOURNAL_CODE)
    path = f"{PLATFORM}/{organization.id}/solutions/{solution.code}/deactivate"

    first = client.post(path, headers=OPERATOR_HEADERS)
    second = client.post(path, headers=OPERATOR_HEADERS)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["solutions"][0]["is_live"] is False


def test_unknown_solution_code_is_not_found(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Свой текст, а не общий: оператор должен понимать, чего именно нет."""
    organization, _ = make_organization(db_session)
    add_solution(db_session, code=JOURNAL_CODE)

    response = client.post(
        f"{PLATFORM}/{organization.id}/solutions/unknown/deactivate", headers=OPERATOR_HEADERS
    )

    assert response.status_code == 404
    assert response.json() == {"detail": SOLUTION_NOT_FOUND_DETAIL}


# --- Журнал -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "payload", "title"),
    [
        ("patch", "subscription", {"paid_until": "2027-06-30"}, PATCH_TITLE),
        ("post", "subscription/deactivate", None, DEACTIVATE_TITLE),
        ("post", f"solutions/{JOURNAL_CODE}/deactivate", None, SOLUTION_TITLE),
    ],
)
def test_write_actions_have_a_readable_title_in_the_journal(
    client: TestClient,
    db_session: Session,
    operator_token: None,
    method: str,
    path: str,
    payload: dict[str, str] | None,
    title: str,
) -> None:
    """В журнале — название из `ACTION_TITLES`, а не код действия.

    Код при этом остаётся кодом: он собран из метода и маршрута
    (`audit.action_code`), и ключ названия совпадает с ним.
    """
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session)
    bind_slot(db_session, organization, tariff, datetime.now(UTC) + timedelta(days=30))
    give_solution(db_session, organization, code=JOURNAL_CODE)

    response = client.request(
        method,
        f"{PLATFORM}/{organization.id}/{path}",
        headers=OPERATOR_HEADERS,
        json=payload,
    )
    assert response.status_code == 200, response.text

    row = events(db_session)[-1]
    assert audit.action_title(row.action) == title
    assert audit.action_title(row.action) != row.action


# --- Правила срока без HTTP -------------------------------------------------


def test_paid_until_is_the_last_included_day_in_moscow() -> None:
    """Граница исключающая: последний день — день момента «за микросекунду до»."""
    assert subscription.paid_until(None) is None
    assert subscription.paid_until(end_of_day(date(2027, 6, 30))) == date(2027, 6, 30)
    # Полночь следующих суток по Москве — это ещё предыдущий включённый день.
    midnight = datetime(2027, 7, 1, 0, 0, tzinfo=MOSCOW)
    assert subscription.paid_until(midnight) == date(2027, 6, 30)


def test_set_current_end_round_trips_through_paid_until(db_session: Session) -> None:
    """Записали день — прочитали тот же день, без сдвига пояса."""
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session)
    bind_slot(db_session, organization, tariff, None)

    subscription.set_current_end(organization, date(2027, 6, 30))
    db_session.commit()

    stored = subscription.as_utc(stored_ends_at(db_session, organization.id))
    assert subscription.paid_until(stored) == date(2027, 6, 30)
    assert stored == end_of_day(date(2027, 6, 30)).astimezone(UTC)


def test_deactivate_current_is_idempotent_at_an_explicit_moment(db_session: Session) -> None:
    """Повторное снятие не «продлевает» и не ломает запись: срок снова «сейчас»."""
    organization, _ = make_organization(db_session)
    tariff = add_tariff(db_session)
    moment = datetime(2027, 1, 1, 12, 0, tzinfo=UTC)
    bind_slot(db_session, organization, tariff, datetime(2027, 6, 30, tzinfo=UTC))

    subscription.deactivate_current(organization, moment)
    first = organization.tariff_ends_at
    subscription.deactivate_current(organization, moment)

    assert first == moment
    assert organization.tariff_ends_at == moment
    assert subscription.is_live(organization.tariff_ends_at, moment) is False


def test_current_slot_reads_the_record_not_the_virtual_move(db_session: Session) -> None:
    """`current_slot`/`next_slot` берут колонки как есть, `organization_slots` — нет."""
    organization, _ = make_organization(db_session)
    current = add_tariff(db_session)
    upcoming = add_tariff(db_session, name="Домовой · 6 месяцев", period="half_year")
    expired = datetime.now(UTC) - timedelta(days=1)
    bind_slot(db_session, organization, current, expired)
    bind_next_slot(db_session, organization, upcoming, datetime.now(UTC) + timedelta(days=90))

    recorded = subscription.current_slot(db_session, organization)
    upcoming_slot = subscription.next_slot(db_session, organization)
    virtual = subscription.organization_slots(organization)

    assert recorded.tariff is not None and recorded.tariff.id == current.id
    assert upcoming_slot.tariff is not None and upcoming_slot.tariff.id == upcoming.id
    # Клиентская логика считает наступившим будущий период — оператор видит запись.
    assert virtual.current_tariff_id == upcoming.id
