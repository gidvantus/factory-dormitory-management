"""Платформенный контур: тарифы — список, правка полей и снятие с продажи (#178).

Проверяется то, что видит кабинет оператора и что является контрактом:

* без сервисного токена ручки закрыты (`401`), cookie основного кабинета контур
  не открывает — это проверено в `tests/test_platform_organizations.py` для всего
  контура, здесь повторяется для тарифов;
* `GET` отдаёт **все** строки прайса, включая скрытые, в порядке `position`, `id`;
* `PATCH` меняет только присланные поля, проверяет занятость названия без учёта
  регистра (`casefold()` в Python), ловит гонку на уникальном индексе;
* `DELETE` ставит `is_visible = false` и строку не удаляет: тариф пропадает из
  публичного прайса, но остаётся у организации, которой он назначен; повторный
  `DELETE` — тоже `204`;
* тексты отказов — дословно те, что перечислены в «Контракте половин»:
  `404 «Тариф не найден»`, `409 «Тариф с таким названием уже есть»` и `422` с
  приставкой `Value error, ` у каждого сообщения валидатора.

Клиентские пути (`/api/tariffs/*`) не трогаются: снятые ручки правки проверяет
`tests/test_tariffs.py`, а платформенные ручки живут отдельно.
"""

from collections.abc import Iterator
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api import platform_tariffs
from app.config import get_settings
from app.models.tariff import Tariff
from app.schemas.platform_tariff import (
    AMOUNT_NEGATIVE_MESSAGE,
    AMOUNT_NOT_NUMBER_MESSAGE,
    AMOUNT_TOO_LARGE_MESSAGE,
    MEMBERS_NEGATIVE_MESSAGE,
    NAME_REQUIRED_MESSAGE,
    NAME_TOO_LONG_MESSAGE,
    PERIOD_UNKNOWN_MESSAGE,
)
from app.security import INVALID_OPERATOR_TOKEN_DETAIL
from tests.conftest import create_user, login, organizations_for

# Заведомо ненастоящий секрет: настоящий в тестах не нужен.
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}
WRONG_HEADERS = {"X-Operator-Token": "not-the-token"}
PLATFORM = "/api/platform/tariffs"


@pytest.fixture
def operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный секрет сервисного контура. Кеш настроек сбрасывается до и после."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


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
    max_members: int | None = None,
    tooltip: str | None = None,
    group_code: str | None = None,
) -> Tariff:
    """Строка прайса прямо в базе: прайс заводит миграция, а не API."""
    tariff = Tariff(
        name=name,
        description=description,
        amount=Decimal(amount),
        currency=currency,
        period=period,
        unit_label=unit_label,
        position=position,
        is_visible=is_visible,
        max_members=max_members,
        tooltip=tooltip,
        group_code=group_code,
    )
    db_session.add(tariff)
    db_session.commit()
    db_session.refresh(tariff)
    return tariff


def error_message(response_text_detail: list[dict[str, object]]) -> str:
    """Текст отказа схемы: `Value error, <сообщение>` — приставку снимает клиент."""
    return str(response_text_detail[0]["msg"])


# --- Токен -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", PLATFORM, None),
        ("patch", f"{PLATFORM}/1", {"name": "Новый"}),
        ("delete", f"{PLATFORM}/1", None),
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
    response = client.get(PLATFORM, headers=WRONG_HEADERS)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


# --- Список ------------------------------------------------------------------


def test_list_returns_every_tariff_including_hidden(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Кабинет оператора — то место, где скрытые строки прайса видно."""
    second = add_tariff(db_session, name="Второй", position=2)
    first = add_tariff(db_session, name="Первый", position=1)
    hidden = add_tariff(db_session, name="Снятый", position=1, is_visible=False)

    response = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["id"] for item in body] == [first.id, hidden.id, second.id]
    assert [item["is_visible"] for item in body] == [True, False, True]


def test_list_has_the_full_response_shape(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Форма ответа — `TariffResponse`: сумму и `price_label` собирает сервер."""
    add_tariff(db_session, amount="1250.50", unit_label="за одно место")

    body = client.get(PLATFORM, headers=OPERATOR_HEADERS).json()[0]

    assert set(body) == {
        "id",
        "name",
        "description",
        "amount",
        "currency",
        "period",
        "unit_label",
        "position",
        "is_visible",
        "max_members",
        "tooltip",
        "group_code",
        "price_label",
    }
    assert body["amount"] == "1250.50"
    assert body["price_label"] == "1\u00a0250,50 ₽ за одно место в месяц"


def test_empty_price_list_is_an_empty_array(client: TestClient, operator_token: None) -> None:
    response = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert response.status_code == 200
    assert response.json() == []


# --- Правка ------------------------------------------------------------------


def test_patch_changes_only_the_fields_it_was_given(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`PATCH` описания не обнуляет название, цену, период и количество мест."""
    tariff = add_tariff(db_session, max_members=15, group_code="growth")

    response = client.patch(
        f"{PLATFORM}/{tariff.id}",
        headers=OPERATOR_HEADERS,
        json={"description": "Только описание"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["description"] == "Только описание"
    assert body["name"] == "Базовый"
    assert body["amount"] == "5000.00"
    assert body["period"] == "month"
    assert body["max_members"] == 15
    assert body["is_visible"] is True

    db_session.expire_all()
    refreshed = db_session.get(Tariff, tariff.id)
    assert refreshed is not None
    assert refreshed.description == "Только описание"
    assert refreshed.name == "Базовый"


def test_patch_edits_every_field_of_the_cabinet_form(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Пять полей формы кабинета: название, описание, цена, период, места."""
    tariff = add_tariff(db_session)

    response = client.patch(
        f"{PLATFORM}/{tariff.id}",
        headers=OPERATOR_HEADERS,
        json={
            "name": "Стандарт",
            "description": "До 15 пользователей",
            "amount": "4900.00",
            "period": "year",
            "max_members": 15,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Стандарт"
    assert body["description"] == "До 15 пользователей"
    assert body["amount"] == "4900.00"
    assert body["period"] == "year"
    assert body["max_members"] == 15
    # `price_label` пересчитан сервером: экран показывает готовую строку.
    assert body["price_label"] == "4\u00a0900 ₽ в год"


def test_patch_strips_the_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Пробелы по краям отбрасываются: «  Рост  » и «Рост» — одно название."""
    tariff = add_tariff(db_session)

    response = client.patch(
        f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS, json={"name": "  Рост  "}
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Рост"


def test_patch_null_description_and_members_are_the_clear_state(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`null` в описании и местах — осмысленное значение, а не «поле не прислали»."""
    tariff = add_tariff(db_session, max_members=15)

    response = client.patch(
        f"{PLATFORM}/{tariff.id}",
        headers=OPERATOR_HEADERS,
        json={"description": None, "max_members": None},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["description"] is None
    # `null` мест — «без ограничения», а не «ноль мест».
    assert body["max_members"] is None


def test_patch_amount_sent_as_a_number_is_accepted(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Кабинет шлёт строку, но число тоже принимается и приводится к копейкам."""
    tariff = add_tariff(db_session)

    response = client.patch(
        f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS, json={"amount": "4900"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["amount"] == "4900.00"


def test_patch_publishes_a_hidden_tariff(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """«Опубликовать» в кабинете — это `PATCH {"is_visible": true}`."""
    tariff = add_tariff(db_session, name="Снятый", is_visible=False)

    response = client.patch(
        f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS, json={"is_visible": True}
    )

    assert response.status_code == 200, response.text
    assert response.json()["is_visible"] is True
    assert [item["id"] for item in client.get("/api/tariffs").json()] == [tariff.id]


def test_patch_of_an_unknown_tariff_is_not_found(client: TestClient, operator_token: None) -> None:
    response = client.patch(f"{PLATFORM}/999999", headers=OPERATOR_HEADERS, json={"name": "Новый"})

    assert response.status_code == 404
    assert response.json() == {"detail": platform_tariffs.TARIFF_NOT_FOUND_DETAIL}


def test_patch_reports_a_taken_name_in_any_case(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Занятость имени — без учёта регистра: `casefold()` в Python, а не в SQL."""
    add_tariff(db_session, name="Рост")
    target = add_tariff(db_session, name="Старт")

    response = client.patch(
        f"{PLATFORM}/{target.id}", headers=OPERATOR_HEADERS, json={"name": "РОСТ"}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Тариф с таким названием уже есть"}


def test_patch_keeps_its_own_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Своя же строка не считается занятой, даже если название в другом регистре."""
    tariff = add_tariff(db_session, name="Рост")

    response = client.patch(
        f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS, json={"name": "РОСТ"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "РОСТ"


def test_patch_rolls_back_when_the_name_is_rejected_by_the_database(
    client: TestClient,
    db_session: Session,
    operator_token: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Гонка на уникальном названии: проверка прошла, коммит — нет.

    Два оператора одновременно переименовывают две строки в одно имя: проверка
    у обоих отвечает «свободно», вторая транзакция падает на уникальном индексе.
    Ветка воспроизводится подменой проверки — иначе до `commit` не доходит ни
    один тест, и удаление `db.rollback()` прошло бы зелёным.
    """
    holder = add_tariff(db_session, name="Занятый")
    target = add_tariff(db_session, name="Цель")

    monkeypatch.setattr(platform_tariffs, "tariff_name_taken", lambda *args, **kwargs: False)

    response = client.patch(
        f"{PLATFORM}/{target.id}", headers=OPERATOR_HEADERS, json={"name": "Занятый"}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Тариф с таким названием уже есть"}

    db_session.expire_all()
    relieved = db_session.get(Tariff, target.id)
    owner = db_session.get(Tariff, holder.id)
    assert relieved is not None and relieved.name == "Цель"
    assert owner is not None and owner.name == "Занятый"

    # Откат не сломал сессию: следующий запрос отвечает, а не падает.
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS).status_code == 200


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"name": "   "}, NAME_REQUIRED_MESSAGE),
        ({"name": None}, NAME_REQUIRED_MESSAGE),
        ({"name": "я" * 121}, NAME_TOO_LONG_MESSAGE),
        ({"amount": "-1.00"}, AMOUNT_NEGATIVE_MESSAGE),
        ({"amount": "100000000.00"}, AMOUNT_TOO_LARGE_MESSAGE),
        ({"amount": "дорого"}, AMOUNT_NOT_NUMBER_MESSAGE),
        ({"period": "week"}, PERIOD_UNKNOWN_MESSAGE),
        ({"period": None}, PERIOD_UNKNOWN_MESSAGE),
        ({"max_members": -1}, MEMBERS_NEGATIVE_MESSAGE),
    ],
)
def test_patch_rejects_invalid_values_with_the_contract_messages(
    client: TestClient,
    db_session: Session,
    operator_token: None,
    payload: dict[str, object],
    message: str,
) -> None:
    """Тексты — часть контракта: фронт снимает приставку `Value error, `."""
    tariff = add_tariff(db_session)

    response = client.patch(f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS, json=payload)

    assert response.status_code == 422, response.text
    assert error_message(response.json()["detail"]) == f"Value error, {message}"


def test_patch_rejects_a_foreign_field(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Правка `currency`/`position` в задачу не входит: лишнее поле — отказ."""
    tariff = add_tariff(db_session)

    response = client.patch(
        f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS, json={"currency": "USD"}
    )

    assert response.status_code == 422
    db_session.expire_all()
    refreshed = db_session.get(Tariff, tariff.id)
    assert refreshed is not None and refreshed.currency == "RUB"


# --- Снятие с продажи ---------------------------------------------------------


def test_delete_hides_the_tariff_and_keeps_the_row(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """«Удаление» — это `is_visible = false`: строку не удаляем."""
    tariff = add_tariff(db_session, name="Удаляемый")

    response = client.delete(f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS)

    assert response.status_code == 204
    assert response.content == b""

    db_session.expire_all()
    stored = db_session.get(Tariff, tariff.id)
    assert stored is not None
    assert stored.is_visible is False


def test_deleted_tariff_disappears_from_the_public_price_list(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    tariff = add_tariff(db_session, name="Удаляемый")
    assert client.get("/api/tariffs").status_code == 200

    assert client.delete(f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS).status_code == 204

    assert client.get("/api/tariffs").json() == []
    # В кабинете оператора строка остаётся: снятая с продажи — не удалённая.
    assert [item["id"] for item in client.get(PLATFORM, headers=OPERATOR_HEADERS).json()] == [
        tariff.id
    ]


def test_deleted_tariff_stays_visible_to_its_organization(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Снятый тариф пропадает из прайса, но организация продолжает его видеть."""
    user = create_user(db_session, email="owner@example.com")
    organization, _ = organizations_for(db_session, user)
    tariff = add_tariff(db_session, name="Назначенный")
    organization.tariff_id = tariff.id
    db_session.commit()
    assert login(client, user.email).status_code == 200

    assert client.delete(f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS).status_code == 204

    assert client.get("/api/tariffs").json() == []
    current = client.get("/api/tariffs/current").json()
    assert current["tariff"]["id"] == tariff.id
    assert current["tariff"]["is_visible"] is False


def test_repeated_delete_is_idempotent(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Повторный `DELETE` по скрытой строке — тот же `204`, а не `404`/`409`."""
    tariff = add_tariff(db_session, is_visible=False)

    response = client.delete(f"{PLATFORM}/{tariff.id}", headers=OPERATOR_HEADERS)

    assert response.status_code == 204
    db_session.expire_all()
    stored = db_session.get(Tariff, tariff.id)
    assert stored is not None and stored.is_visible is False


def test_delete_of_an_unknown_tariff_is_not_found(client: TestClient, operator_token: None) -> None:
    response = client.delete(f"{PLATFORM}/999999", headers=OPERATOR_HEADERS)

    assert response.status_code == 404
    assert response.json() == {"detail": platform_tariffs.TARIFF_NOT_FOUND_DETAIL}


def test_delete_does_not_touch_the_neighbour(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Снятие одной строки не меняет соседнюю и не трогает весь прайс."""
    first = add_tariff(db_session, name="Первый", position=1)
    second = add_tariff(db_session, name="Второй", position=2)

    assert client.delete(f"{PLATFORM}/{first.id}", headers=OPERATOR_HEADERS).status_code == 204

    db_session.expire_all()
    stored = db_session.get(Tariff, second.id)
    assert stored is not None and stored.is_visible is True
    assert [item["id"] for item in client.get("/api/tariffs").json()] == [second.id]
