"""Публичный прайс и правка тарифов в кабинете (issue #26).

Критерии готовности разложены по блокам:

* публичная ручка открыта анониму и отдаёт только `is_visible=true` в порядке
  `position`, затем `id`, с непустым `price_label`;
* `manage` и правка — под ролью `owner`/`admin`: 401 без cookie, 404 без
  организации, 403 у `manager`/`commandant`;
* `409` на название, отличающееся только регистром; `422` на отрицательную сумму
  и несуществующий период; `404` на правку и удаление несуществующего тарифа.

Плюс отдельный блок на `format_price`: разряды, копейки, «за что», все три
периода и незнакомая валюта — это то, что видит аноним на странице.
"""

from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

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


def editor(
    client: TestClient, db_session: Session, role: str = "owner", email: str = "owner@example.com"
) -> None:
    """Войти пользователем с организацией и указанной ролью."""
    user = sign_in(client, db_session, email=email)
    organizations_for(db_session, user, role=role)


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


def test_format_price_puts_unit_label_before_period() -> None:
    assert (
        format_price(Decimal("5000.00"), "RUB", "month", "за одно место")
        == f"5{NBSP}000 ₽ за одно место в месяц"
    )


def test_format_price_keeps_unknown_currency_code() -> None:
    assert format_price(Decimal("10.00"), "KZT", "month") == "10 KZT в месяц"
    assert format_price(Decimal("10.00"), "USD", "month") == "10 $ в месяц"
    assert format_price(Decimal("10.00"), "EUR", "month") == "10 € в месяц"


# --- 1. Публичная ручка ------------------------------------------------------


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
    add_tariff(db_session, name="Скрытый", is_visible=False, amount="10.00")

    response = client.get("/api/tariffs")

    assert response.json()[0]["price_label"] == f"1{NBSP}250,50 ₽ за одно место в месяц"
    assert response.json()[0]["editable"] is False


def test_invisible_tariff_also_gets_a_price_label_in_cabinet(
    client: TestClient, db_session: Session
) -> None:
    """Кабинет показывает скрытые тарифы, поэтому `price_label` нужен и им."""
    editor(client, db_session)
    add_tariff(db_session, name="Скрытый", is_visible=False, amount="7000.00")

    response = client.get("/api/tariffs/manage")

    assert response.status_code == 200, response.text
    assert response.json()[0]["price_label"] == f"7{NBSP}000 ₽ в месяц"
    assert response.json()[0]["editable"] is True


def test_amount_travels_as_a_string(client: TestClient, db_session: Session) -> None:
    """`Numeric` едет строкой: копейки не должны теряться на float в JSON."""
    add_tariff(db_session, amount="1250.50")

    response = client.get("/api/tariffs")

    assert response.json()[0]["amount"] == "1250.50"


# --- 2. Доступ к кабинетным ручкам -------------------------------------------


def test_manage_without_cookie_is_unauthorized(client: TestClient) -> None:
    response = client.get("/api/tariffs/manage")

    assert response.status_code == 401


def test_manage_without_organization_is_not_found(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)

    response = client.get("/api/tariffs/manage")

    assert response.status_code == 404
    assert response.json()["detail"] == "Организация не найдена"


def test_manage_is_forbidden_for_manager(client: TestClient, db_session: Session) -> None:
    editor(client, db_session, role="manager")

    response = client.get("/api/tariffs/manage")

    assert response.status_code == 403
    assert response.json()["detail"] == "Недостаточно прав"


def test_manage_is_forbidden_for_commandant(client: TestClient, db_session: Session) -> None:
    editor(client, db_session, role="commandant")

    assert client.get("/api/tariffs/manage").status_code == 403


def test_manage_shows_hidden_tariffs_to_owner(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)
    add_tariff(db_session, name="Видимый", position=1)
    add_tariff(db_session, name="Скрытый", position=2, is_visible=False)

    response = client.get("/api/tariffs/manage")

    assert response.status_code == 200
    assert [item["name"] for item in response.json()] == ["Видимый", "Скрытый"]
    assert all(item["editable"] is True for item in response.json())


def test_manage_is_allowed_for_admin(client: TestClient, db_session: Session) -> None:
    editor(client, db_session, role="admin", email="admin@example.com")

    assert client.get("/api/tariffs/manage").status_code == 200


# --- 3. Создание -------------------------------------------------------------


def test_create_appends_to_the_end_of_the_list(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)
    add_tariff(db_session, name="Первый", position=1)

    response = client.post("/api/tariffs", json={"name": "Второй", "amount": "1000.00"})

    assert response.status_code == 201, response.text
    created = response.json()
    assert created["position"] == 2
    assert created["is_visible"] is True
    assert created["price_label"] == f"1{NBSP}000 ₽ в месяц"
    assert created["editable"] is True


def test_first_tariff_gets_position_one(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)

    response = client.post("/api/tariffs", json={"name": "Первый", "amount": "0"})

    assert response.status_code == 201, response.text
    assert response.json()["position"] == 1


def test_create_is_forbidden_for_manager(client: TestClient, db_session: Session) -> None:
    editor(client, db_session, role="manager")

    response = client.post("/api/tariffs", json={"name": "Новый", "amount": "100"})

    assert response.status_code == 403


def test_create_rejects_name_differing_only_in_case(
    client: TestClient, db_session: Session
) -> None:
    editor(client, db_session)
    add_tariff(db_session, name="Basic plan")

    response = client.post("/api/tariffs", json={"name": "basic PLAN", "amount": "100"})

    assert response.status_code == 409
    assert response.json()["detail"] == "Тариф с таким названием уже есть"


def test_create_rejects_negative_amount(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)

    response = client.post("/api/tariffs", json={"name": "Минус", "amount": "-1"})

    assert response.status_code == 422


def test_create_rejects_unknown_period(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)

    response = client.post(
        "/api/tariffs", json={"name": "Недельный", "amount": "100", "period": "неделя"}
    )

    assert response.status_code == 422


def test_create_rejects_three_decimal_digits(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)

    response = client.post("/api/tariffs", json={"name": "Точный", "amount": "10.005"})

    assert response.status_code == 422


def test_create_rejects_lowercase_currency(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)

    response = client.post(
        "/api/tariffs", json={"name": "Долларовый", "amount": "10", "currency": "usd"}
    )

    assert response.status_code == 422


def test_create_trims_name_and_turns_empty_description_into_null(
    client: TestClient, db_session: Session
) -> None:
    editor(client, db_session)

    response = client.post(
        "/api/tariffs",
        json={"name": "  Годовой  ", "amount": "100", "description": "   ", "unit_label": " "},
    )

    assert response.status_code == 201, response.text
    created = response.json()
    assert created["name"] == "Годовой"
    assert created["description"] is None
    assert created["unit_label"] is None


# --- 4. Правка ---------------------------------------------------------------


def test_patch_changes_only_sent_fields(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)
    tariff = add_tariff(db_session, name="Базовый", amount="5000.00")

    response = client.patch(f"/api/tariffs/{tariff.id}", json={"amount": "7500.00"})

    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["amount"] == "7500.00"
    assert updated["name"] == "Базовый"
    assert updated["price_label"] == f"7{NBSP}500 ₽ в месяц"


def test_patch_clears_description_with_null(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)
    tariff = add_tariff(db_session, description="Было")

    response = client.patch(f"/api/tariffs/{tariff.id}", json={"description": None})

    assert response.status_code == 200, response.text
    assert response.json()["description"] is None


def test_patch_rejects_null_amount(client: TestClient, db_session: Session) -> None:
    """`amount: null` — ошибка, а не «оставить прежнюю сумму»."""
    editor(client, db_session)
    tariff = add_tariff(db_session)

    response = client.patch(f"/api/tariffs/{tariff.id}", json={"amount": None})

    assert response.status_code == 422


def test_patch_rejects_null_period(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)
    tariff = add_tariff(db_session)

    response = client.patch(f"/api/tariffs/{tariff.id}", json={"period": None})

    assert response.status_code == 422


def test_patch_rejects_taken_name(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)
    add_tariff(db_session, name="Первый")
    second = add_tariff(db_session, name="Второй")

    response = client.patch(f"/api/tariffs/{second.id}", json={"name": "первый"})

    assert response.status_code == 409


def test_patch_keeps_own_name(client: TestClient, db_session: Session) -> None:
    """Смена только суммы не конфликтует сама с собой."""
    editor(client, db_session)
    tariff = add_tariff(db_session, name="Базовый")

    response = client.patch(f"/api/tariffs/{tariff.id}", json={"name": "Базовый"})

    assert response.status_code == 200, response.text


def test_patch_hides_tariff_from_public_page(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)
    tariff = add_tariff(db_session)

    assert client.patch(f"/api/tariffs/{tariff.id}", json={"is_visible": False}).status_code == 200

    assert client.get("/api/tariffs").json() == []


def test_patch_missing_tariff_is_not_found(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)

    response = client.patch("/api/tariffs/9999", json={"amount": "100"})

    assert response.status_code == 404
    assert response.json()["detail"] == "Тариф не найден"


def test_patch_is_forbidden_for_manager(client: TestClient, db_session: Session) -> None:
    editor(client, db_session, role="manager")
    tariff = add_tariff(db_session)

    response = client.patch(f"/api/tariffs/{tariff.id}", json={"amount": "100"})

    assert response.status_code == 403


# --- 5. Удаление -------------------------------------------------------------


def test_delete_removes_the_tariff(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)
    tariff = add_tariff(db_session)

    response = client.delete(f"/api/tariffs/{tariff.id}")

    assert response.status_code == 204
    assert client.get("/api/tariffs/manage").json() == []


def test_delete_missing_tariff_is_not_found(client: TestClient, db_session: Session) -> None:
    editor(client, db_session)

    response = client.delete("/api/tariffs/9999")

    assert response.status_code == 404
    assert response.json()["detail"] == "Тариф не найден"


def test_delete_is_forbidden_for_manager(client: TestClient, db_session: Session) -> None:
    editor(client, db_session, role="manager")
    tariff = add_tariff(db_session)

    response = client.delete(f"/api/tariffs/{tariff.id}")

    assert response.status_code == 403


def test_editing_requires_a_session(client: TestClient, db_session: Session) -> None:
    tariff = add_tariff(db_session)

    assert client.post("/api/tariffs", json={"name": "X", "amount": "1"}).status_code == 401
    assert client.patch(f"/api/tariffs/{tariff.id}", json={"amount": "1"}).status_code == 401
    assert client.delete(f"/api/tariffs/{tariff.id}").status_code == 401
