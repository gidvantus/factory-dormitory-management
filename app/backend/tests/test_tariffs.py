"""Чтение тарифов: публичный прайс и тариф организации (issue #34).

Критерии готовности разложены по блокам:

* публичная ручка открыта анониму и отдаёт только `is_visible=true` в порядке
  `position`, затем `id`, с непустым `price_label` и суммой-строкой;
* `GET /api/tariffs/current` читает любой участник организации: 401 без cookie,
  404 без организации, `tariff: null` до привязки и сам тариф после;
* ручек правки больше нет: `GET /manage`, `POST`, `PATCH`/`DELETE /{id}` и
  `PUT /current` отвечают 404/405 и отсутствуют в `openapi.json`.

Плюс отдельный блок на `format_price`: разряды, копейки, «за что», все периоды
списания и незнакомая валюта — это то, что видит аноним на странице.
"""

from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.organization import Organization
from app.models.tariff import Tariff
from app.pricing import format_amount, format_price
from tests.conftest import organizations_for, sign_in

# Неразрывный пробел — разделитель разрядов в цене. Обычный пробел здесь был бы
# ошибкой: строка «5 000 ₽» ломалась бы переносом между «5» и «000».
NBSP = "\u00a0"


def add_tariff(
    db_session: Session,
    name: str = "Базовый",
    amount: str = "5000.00",
    position: int = 0,
    is_visible: bool = True,
    description: str | None = "Всё основное",
    currency: str = "RUB",
    period: str = "month",
    unit_label: str | None = None,
) -> Tariff:
    """Тариф прямо в базе: публичная ручка не требует, чтобы его кто-то создал через API."""
    tariff = Tariff(
        name=name,
        description=description,
        amount=Decimal(amount),
        currency=currency,
        period=period,
        unit_label=unit_label,
        position=position,
        is_visible=is_visible,
    )
    db_session.add(tariff)
    db_session.commit()
    db_session.refresh(tariff)
    return tariff


def member(
    client: TestClient, db_session: Session, role: str = "owner", email: str = "owner@example.com"
) -> Organization:
    """Войти участником организации с указанной ролью. Возвращает его организацию."""
    user = sign_in(client, db_session, email=email)
    organization, _ = organizations_for(db_session, user, role=role)
    return organization


def bind_tariff(db_session: Session, organization: Organization, tariff: Tariff) -> None:
    """Привязать тариф к организации так, как это сделает поток покупки.

    Ручки выбора тарифа в задаче нет намеренно: ссылку `organizations.tariff_id`
    заполнит отдельная задача, поэтому тест ставит её в базу напрямую.
    """
    organization.tariff_id = tariff.id
    db_session.commit()


# --- format_price ------------------------------------------------------------


def test_format_amount_skips_zero_kopecks() -> None:
    assert format_amount(Decimal("5000.00")) == f"5{NBSP}000"
    assert format_amount(Decimal("0")) == "0"
    assert format_amount(Decimal("99999999.99")) == f"99{NBSP}999{NBSP}999,99"


def test_format_amount_keeps_kopecks_in_russian_notation() -> None:
    assert format_amount(Decimal("1250.50")) == f"1{NBSP}250,50"
    assert format_amount(Decimal("0.05")) == "0,05"


def test_format_price_uses_symbol_and_period() -> None:
    assert format_price(Decimal("5000.00"), "RUB", "month") == f"5{NBSP}000 ₽ в месяц"
    assert format_price(Decimal("60000.00"), "RUB", "year") == f"60{NBSP}000 ₽ в год"
    assert format_price(Decimal("3000.00"), "RUB", "once") == f"3{NBSP}000 ₽ разово"
    # Полугодовой тариф прайса читается как «за 6 месяцев», а не «в полгода».
    assert format_price(Decimal("50000.00"), "RUB", "half_year") == f"50{NBSP}000 ₽ за 6 месяцев"


def test_format_price_puts_unit_label_before_period() -> None:
    assert (
        format_price(Decimal("5000.00"), "RUB", "month", "за одно место")
        == f"5{NBSP}000 ₽ за одно место в месяц"
    )


def test_format_price_keeps_unknown_currency_code() -> None:
    assert format_price(Decimal("10.00"), "KZT", "month") == "10 KZT в месяц"
    assert format_price(Decimal("10.00"), "USD", "month") == "10 $ в месяц"
    assert format_price(Decimal("10.00"), "EUR", "month") == "10 € в месяц"


# --- 1. Публичный список ------------------------------------------------------


def test_public_list_is_open_to_anonymous(client: TestClient, db_session: Session) -> None:
    add_tariff(db_session)

    response = client.get("/api/tariffs")

    assert response.status_code == 200, response.text
    assert len(response.json()) == 1


def test_public_list_of_empty_table_is_empty(client: TestClient) -> None:
    response = client.get("/api/tariffs")

    assert response.status_code == 200
    assert response.json() == []


def test_public_list_hides_invisible_tariffs(client: TestClient, db_session: Session) -> None:
    add_tariff(db_session, name="Видимый", position=1)
    add_tariff(db_session, name="Скрытый", position=2, is_visible=False)

    response = client.get("/api/tariffs")

    assert response.status_code == 200
    assert [item["name"] for item in response.json()] == ["Видимый"]


def test_public_list_skips_hidden_even_with_query_parameters(
    client: TestClient, db_session: Session
) -> None:
    """Скрытый тариф не показывается ни при каких параметрах запроса."""
    add_tariff(db_session, name="Скрытый", is_visible=False)

    response = client.get("/api/tariffs", params={"is_visible": "false", "include_hidden": "1"})

    assert response.status_code == 200
    assert response.json() == []


def test_public_list_is_ordered_by_position_then_id(
    client: TestClient, db_session: Session
) -> None:
    second = add_tariff(db_session, name="Второй", position=2)
    first = add_tariff(db_session, name="Первый", position=1)
    same_position = add_tariff(db_session, name="Тот же порядок", position=1)

    response = client.get("/api/tariffs")

    assert [item["id"] for item in response.json()] == [
        first.id,
        same_position.id,
        second.id,
    ]


def test_public_list_gives_every_tariff_a_price_label(
    client: TestClient, db_session: Session
) -> None:
    add_tariff(db_session, name="Видимый", amount="1250.50", unit_label="за одно место")

    response = client.get("/api/tariffs")

    assert response.json()[0]["price_label"] == f"1{NBSP}250,50 ₽ за одно место в месяц"


def test_amount_travels_as_a_string(client: TestClient, db_session: Session) -> None:
    """`Numeric` едет строкой: копейки не должны теряться на float в JSON."""
    add_tariff(db_session, amount="1250.50")

    response = client.get("/api/tariffs")

    assert response.json()[0]["amount"] == "1250.50"


def test_public_list_gives_a_half_year_plan_its_own_price(
    client: TestClient, db_session: Session
) -> None:
    """Полугодовой период (тариф «Стандарт») проходит `CHECK` и даёт свою цену."""
    add_tariff(
        db_session,
        name="Стандарт",
        amount="50000.00",
        period="half_year",
        description="До 15 пользователей",
    )

    response = client.get("/api/tariffs")

    assert response.status_code == 200, response.text
    assert response.json()[0]["price_label"] == f"50{NBSP}000 ₽ за 6 месяцев"
    assert response.json()[0]["period"] == "half_year"


# --- 2. Тариф организации: чтение ---------------------------------------------


def test_current_tariff_is_empty_until_the_organization_gets_one(
    client: TestClient, db_session: Session
) -> None:
    member(client, db_session)

    response = client.get("/api/tariffs/current")

    assert response.status_code == 200, response.text
    # `editable` из ответа убран: правки в кабинете больше нет.
    assert response.json() == {"tariff": None}


def test_organization_sees_the_tariff_bound_to_it(client: TestClient, db_session: Session) -> None:
    organization = member(client, db_session)
    tariff = add_tariff(db_session, unit_label="за одно место")
    bind_tariff(db_session, organization, tariff)

    response = client.get("/api/tariffs/current")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tariff"]["id"] == tariff.id
    assert body["tariff"]["name"] == "Базовый"
    assert body["tariff"]["price_label"] == f"5{NBSP}000 ₽ за одно место в месяц"


def test_hidden_tariff_stays_visible_to_its_organization(
    client: TestClient, db_session: Session
) -> None:
    """Скрытый тариф не продаётся, но у организации, которой он назначен, не исчезает."""
    organization = member(client, db_session)
    tariff = add_tariff(db_session, is_visible=False)
    bind_tariff(db_session, organization, tariff)

    body = client.get("/api/tariffs/current").json()

    assert body["tariff"]["id"] == tariff.id
    assert body["tariff"]["is_visible"] is False


def test_manager_reads_the_organization_tariff_like_the_owner(
    client: TestClient, db_session: Session
) -> None:
    """Раздела правки больше нет: роль `manager` видит ровно то же, что владелец."""
    organization = member(client, db_session, role="manager")
    tariff = add_tariff(db_session)
    bind_tariff(db_session, organization, tariff)

    response = client.get("/api/tariffs/current")

    assert response.status_code == 200, response.text
    assert response.json()["tariff"]["id"] == tariff.id


def test_organization_tariff_requires_a_session(client: TestClient) -> None:
    assert client.get("/api/tariffs/current").status_code == 401


def test_organization_tariff_without_organization_is_not_found(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session, email="lonely@example.com")

    response = client.get("/api/tariffs/current")

    assert response.status_code == 404
    assert response.json()["detail"] == "Организация не найдена"


def test_organization_sees_only_its_own_tariff(client: TestClient, db_session: Session) -> None:
    """Привязка одной организации не видна другой."""
    first = member(client, db_session, email="first@example.com")
    tariff = add_tariff(db_session)
    bind_tariff(db_session, first, tariff)
    client.post("/api/auth/logout")

    member(client, db_session, email="second@example.com")

    assert client.get("/api/tariffs/current").json() == {"tariff": None}


# --- 3. Ручки правки сняты ----------------------------------------------------

# Пары «метод и путь», которые задача убирает вместе с редактором прайса.
REMOVED_ROUTES: list[tuple[str, str, dict[str, object] | None]] = [
    ("GET", "/api/tariffs/manage", None),
    ("POST", "/api/tariffs", {"name": "Новый", "amount": "100"}),
    ("PATCH", "/api/tariffs/1", {"amount": "100"}),
    ("DELETE", "/api/tariffs/1", None),
    ("PUT", "/api/tariffs/current", {"tariff_id": 1}),
]


def test_editing_routes_are_gone(client: TestClient, db_session: Session) -> None:
    """Снятые ручки отвечают 404/405 — «метод не тот» или «пути нет», но не работают.

    Точный код зависит от маршрутизатора: у `/api/tariffs` и
    `/api/tariffs/current` метод не совпадает (405), а `/manage` и
    `/{tariff_id}` — это вовсе исчезнувшие пути (404).
    """
    member(client, db_session)
    add_tariff(db_session)

    for method, path, payload in REMOVED_ROUTES:
        response = client.request(method, path, json=payload)
        assert response.status_code in {404, 405}, f"{method} {path}: {response.status_code}"


def test_editing_routes_are_gone_for_anonymous_visitors(client: TestClient) -> None:
    """Без сессии снятые ручки тоже не отвечают 401 — их просто нет."""
    for method, path, payload in REMOVED_ROUTES:
        response = client.request(method, path, json=payload)
        assert response.status_code in {404, 405}, f"{method} {path}: {response.status_code}"


def test_removed_routes_are_absent_from_openapi(client: TestClient) -> None:
    paths = client.get("/openapi.json").json()["paths"]

    assert "/api/tariffs/manage" not in paths
    assert set(paths["/api/tariffs"]) == {"get"}
    assert set(paths["/api/tariffs/current"]) == {"get"}
