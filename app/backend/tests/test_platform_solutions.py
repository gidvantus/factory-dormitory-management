"""Платформенный контур: каталог решений — список, правка полей и снятие с продажи (#188).

Проверяется то, что видит кабинет оператора и что является контрактом:

* без сервисного токена ручки закрыты (`401`), cookie основного кабинета контур
  не открывает — это проверено в `tests/test_platform_organizations.py` для всего
  контура, здесь повторяется для решений;
* `GET` отдаёт **все** строки каталога, включая скрытые, в порядке `position`, `id`;
* `PATCH` меняет только присланные поля, проверяет занятость названия без учёта
  регистра (`casefold()` в Python), ловит гонку на уникальном индексе, а
  `price_label` пересчитывает под новую цену, валюту и период;
* `code` в теле нет: это гейт платной функции и `UNIQUE` в таблице, поэтому
  присланное поле отсекает `extra="forbid"` стандартным текстом `pydantic`;
* `DELETE` ставит `is_visible = false` и строку не удаляет: решение пропадает из
  магазина, но право организации на него продолжает действовать; повторный
  `DELETE` — тоже `204`;
* тексты отказов — дословно те, что перечислены в «Контракте половин»:
  `404 «Решение не найдено»`, `409 «Решение с таким названием уже есть»` и `422` с
  приставкой `Value error, ` у каждого сообщения валидатора.

Строку каталога заводит тест (`tests/conftest.add_solution`): seed живёт в
миграции, которая на `Base.metadata.create_all` не выполняется.
"""

from collections.abc import Iterator
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api import platform_solutions
from app.config import get_settings
from app.models.solution import MAX_SOLUTION_AMOUNT, Solution
from app.models.tariff import MAX_TARIFF_AMOUNT
from app.schemas.platform_solution import (
    CURRENCY_INVALID_MESSAGE,
    MAX_POSITION,
    POSITION_NEGATIVE_MESSAGE,
    POSITION_NOT_INTEGER_MESSAGE,
    POSITION_TOO_LARGE_MESSAGE,
)
from app.schemas.platform_tariff import (
    AMOUNT_NEGATIVE_MESSAGE,
    AMOUNT_NOT_NUMBER_MESSAGE,
    AMOUNT_TOO_LARGE_MESSAGE,
    DESCRIPTION_INVALID_MESSAGE,
    IS_VISIBLE_INVALID_MESSAGE,
    NAME_REQUIRED_MESSAGE,
    NAME_TOO_LONG_MESSAGE,
    PERIOD_UNKNOWN_MESSAGE,
)
from app.security import INVALID_OPERATOR_TOKEN_DETAIL
from tests.conftest import JOURNAL_CODE, add_solution, organizations_for, sign_in

# Заведомо ненастоящий секрет: настоящий в тестах не нужен.
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}
WRONG_HEADERS = {"X-Operator-Token": "not-the-token"}
PLATFORM = "/api/platform/solutions"
CATALOG_URL = "/api/solutions"

# Подпись цены собирает сервер (`app.pricing.format_price`).
PRICE_LABEL = "500 ₽ в месяц"


@pytest.fixture
def operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный секрет сервисного контура. Кеш настроек сбрасывается до и после."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


def error_message(response_detail: list[dict[str, object]]) -> str:
    """Текст отказа схемы: `Value error, <сообщение>` — приставку снимает клиент."""
    return str(response_detail[0]["msg"])


# --- Токен -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", PLATFORM, None),
        ("patch", f"{PLATFORM}/1", {"name": "Новое"}),
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


def test_list_returns_every_solution_including_hidden(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Кабинет оператора — то место, где снятые с продажи строки видно."""
    second = add_solution(db_session, code=JOURNAL_CODE, position=2)
    first = add_solution(db_session, code="telegram_notifications", position=1)
    hidden = add_solution(
        db_session, code="hidden_one", name="Скрытое", position=1, is_visible=False
    )

    response = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    # Порядок `position`, затем `id`: ничья у первых двух строк решается `id`.
    assert [item["id"] for item in body] == [first.id, hidden.id, second.id]
    assert [item["is_visible"] for item in body] == [True, False, True]


def test_list_has_the_full_response_shape(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Форма ответа — `SolutionAdminResponse`: сумму и `price_label` собирает сервер."""
    solution = add_solution(db_session, amount="1250.50", position=7)

    body = client.get(PLATFORM, headers=OPERATOR_HEADERS).json()[0]

    assert set(body) == {
        "id",
        "code",
        "name",
        "description",
        "amount",
        "currency",
        "period",
        "position",
        "is_visible",
        "price_label",
        "created_at",
        "updated_at",
    }
    assert body["id"] == solution.id
    assert body["code"] == "telegram_notifications"
    assert body["amount"] == "1250.50"
    assert body["position"] == 7
    assert body["price_label"] == "1\u00a0250,50 ₽ в месяц"
    assert body["created_at"] is not None
    assert body["updated_at"] is not None


def test_empty_catalog_is_an_empty_array(client: TestClient, operator_token: None) -> None:
    response = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert response.status_code == 200
    assert response.json() == []


# --- Правка ------------------------------------------------------------------


def test_patch_changes_only_the_fields_it_was_given(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`PATCH` описания не обнуляет название, цену, валюту, период и порядок."""
    solution = add_solution(db_session, position=3)

    response = client.patch(
        f"{PLATFORM}/{solution.id}",
        headers=OPERATOR_HEADERS,
        json={"description": "Только описание"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["description"] == "Только описание"
    assert body["name"] == "Уведомления в Telegram"
    assert body["amount"] == "500.00"
    assert body["currency"] == "RUB"
    assert body["period"] == "month"
    assert body["position"] == 3
    assert body["is_visible"] is True

    db_session.expire_all()
    refreshed = db_session.get(Solution, solution.id)
    assert refreshed is not None
    assert refreshed.description == "Только описание"
    assert refreshed.amount == Decimal("500.00")


def test_patch_edits_every_field_of_the_cabinet_form(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Семь полей формы кабинета: название, описание, цена, валюта, период, порядок, состояние."""
    solution = add_solution(db_session)

    response = client.patch(
        f"{PLATFORM}/{solution.id}",
        headers=OPERATOR_HEADERS,
        json={
            "name": "Журнал действий",
            "description": "Кто, когда и что изменил",
            "amount": "1500.00",
            "currency": "USD",
            "period": "year",
            "position": 0,
            "is_visible": False,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Журнал действий"
    assert body["description"] == "Кто, когда и что изменил"
    assert body["amount"] == "1500.00"
    assert body["currency"] == "USD"
    assert body["period"] == "year"
    assert body["position"] == 0
    assert body["is_visible"] is False
    # `price_label` пересчитан сервером под новую цену, валюту и период.
    assert body["price_label"] == "1\u00a0500 $ в год"
    # `code` правкой не меняется: это гейт платной функции.
    assert body["code"] == "telegram_notifications"


def test_patch_strips_the_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Пробелы по краям отбрасываются: «  Журнал  » и «Журнал» — одно название."""
    solution = add_solution(db_session)

    response = client.patch(
        f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS, json={"name": "  Журнал  "}
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Журнал"


def test_patch_null_description_is_the_clear_state(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`null` в описании — осмысленное значение («описания нет»), а не «не прислали»."""
    solution = add_solution(db_session)

    response = client.patch(
        f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS, json={"description": None}
    )

    assert response.status_code == 200, response.text
    assert response.json()["description"] is None


@pytest.mark.parametrize(
    ("amount", "expected"),
    [
        # Число приходит из JSON без кавычек: кабинет шлёт строку, но схема
        # обещает принимать и то, и другое (`parse_amount`).
        (1500, "1500.00"),
        (1500.5, "1500.50"),
    ],
)
def test_patch_amount_sent_as_a_number_is_accepted(
    client: TestClient,
    db_session: Session,
    operator_token: None,
    amount: int | float,
    expected: str,
) -> None:
    solution = add_solution(db_session)

    response = client.patch(
        f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS, json={"amount": amount}
    )

    assert response.status_code == 200, response.text
    assert response.json()["amount"] == expected


def test_patch_publishes_a_hidden_solution(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """«Опубликовать» в кабинете — это `PATCH {"is_visible": true}`."""
    solution = add_solution(db_session, is_visible=False)

    response = client.patch(
        f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS, json={"is_visible": True}
    )

    assert response.status_code == 200, response.text
    assert response.json()["is_visible"] is True
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS).json()[0]["is_visible"] is True


def test_patch_of_an_unknown_solution_is_not_found(
    client: TestClient, operator_token: None
) -> None:
    response = client.patch(f"{PLATFORM}/999999", headers=OPERATOR_HEADERS, json={"name": "Новое"})

    assert response.status_code == 404
    assert response.json() == {"detail": platform_solutions.SOLUTION_NOT_FOUND_DETAIL}


def test_patch_reports_a_taken_name_in_any_case(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Занятость имени — без учёта регистра: `casefold()` в Python, а не в SQL."""
    add_solution(db_session, code=JOURNAL_CODE)
    target = add_solution(db_session, code="telegram_notifications")

    response = client.patch(
        f"{PLATFORM}/{target.id}", headers=OPERATOR_HEADERS, json={"name": "ЖУРНАЛ ДЕЙСТВИЙ"}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Решение с таким названием уже есть"}


def test_patch_keeps_its_own_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Своя же строка не считается занятой, даже если название в другом регистре."""
    solution = add_solution(db_session, name="Журнал действий")

    response = client.patch(
        f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS, json={"name": "ЖУРНАЛ ДЕЙСТВИЙ"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "ЖУРНАЛ ДЕЙСТВИЙ"


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
    holder = add_solution(db_session, code=JOURNAL_CODE, name="Занятое")
    target = add_solution(db_session, code="telegram_notifications", name="Цель")

    monkeypatch.setattr(platform_solutions, "solution_name_taken", lambda *args, **kwargs: False)

    response = client.patch(
        f"{PLATFORM}/{target.id}", headers=OPERATOR_HEADERS, json={"name": "Занятое"}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Решение с таким названием уже есть"}

    db_session.expire_all()
    relieved = db_session.get(Solution, target.id)
    owner = db_session.get(Solution, holder.id)
    assert relieved is not None and relieved.name == "Цель"
    assert owner is not None and owner.name == "Занятое"

    # Откат не сломал сессию: следующий запрос отвечает, а не падает.
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS).status_code == 200


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"name": "   "}, NAME_REQUIRED_MESSAGE),
        ({"name": None}, NAME_REQUIRED_MESSAGE),
        ({"name": "я" * 121}, NAME_TOO_LONG_MESSAGE),
        ({"description": 42}, DESCRIPTION_INVALID_MESSAGE),
        ({"amount": "-1.00"}, AMOUNT_NEGATIVE_MESSAGE),
        ({"amount": "100000000.00"}, AMOUNT_TOO_LARGE_MESSAGE),
        ({"amount": "дорого"}, AMOUNT_NOT_NUMBER_MESSAGE),
        ({"amount": None}, AMOUNT_NOT_NUMBER_MESSAGE),
        ({"currency": "rub"}, CURRENCY_INVALID_MESSAGE),
        ({"currency": "RU"}, CURRENCY_INVALID_MESSAGE),
        ({"currency": "R1B"}, CURRENCY_INVALID_MESSAGE),
        ({"currency": None}, CURRENCY_INVALID_MESSAGE),
        ({"period": "week"}, PERIOD_UNKNOWN_MESSAGE),
        ({"period": None}, PERIOD_UNKNOWN_MESSAGE),
        ({"position": "3"}, POSITION_NOT_INTEGER_MESSAGE),
        ({"position": None}, POSITION_NOT_INTEGER_MESSAGE),
        ({"position": 1.5}, POSITION_NOT_INTEGER_MESSAGE),
        ({"position": True}, POSITION_NOT_INTEGER_MESSAGE),
        ({"position": -1}, POSITION_NEGATIVE_MESSAGE),
        # Потолок колонки `INTEGER`: без него запрос падал бы на `commit`
        # ошибкой типа данных, и клиент видел бы `500`, а не `422`.
        ({"position": MAX_POSITION + 1}, POSITION_TOO_LARGE_MESSAGE),
        ({"is_visible": None}, IS_VISIBLE_INVALID_MESSAGE),
        ({"is_visible": 1}, IS_VISIBLE_INVALID_MESSAGE),
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
    solution = add_solution(db_session)

    response = client.patch(f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS, json=payload)

    assert response.status_code == 422, response.text
    assert error_message(response.json()["detail"]) == f"Value error, {message}"


def test_patch_rejects_code_with_the_standard_message(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`code` — гейт платной функции и `UNIQUE`: присланное поле отсекает `extra="forbid"`.

    Своего русского текста у этого отказа нет намеренно (как у лишнего поля
    тарифа): клиент показывает стандартное сообщение `pydantic`.
    """
    solution = add_solution(db_session)

    response = client.patch(
        f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS, json={"code": "journal"}
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail[0]["type"] == "extra_forbidden"
    assert detail[0]["loc"] == ["body", "code"]

    db_session.expire_all()
    refreshed = db_session.get(Solution, solution.id)
    assert refreshed is not None and refreshed.code == "telegram_notifications"


def test_amount_ceiling_is_the_same_for_solutions_and_tariffs() -> None:
    """Потолок цены решения и тарифа объявлен одинаково — потолком колонки.

    Проверка нужна схеме решения: она отсекает `MAX_SOLUTION_AMOUNT` вторым
    рубежом после общего `parse_amount`. Пока числа равны, второй рубеж не
    срабатывает; если они разойдутся, тест скажет об этом первым.
    """
    assert MAX_SOLUTION_AMOUNT == MAX_TARIFF_AMOUNT


def test_patch_accepts_the_maximum_amount(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Граница включительно: сам потолок колонки — ещё допустимая цена."""
    solution = add_solution(db_session)

    response = client.patch(
        f"{PLATFORM}/{solution.id}",
        headers=OPERATOR_HEADERS,
        json={"amount": str(MAX_SOLUTION_AMOUNT)},
    )

    assert response.status_code == 200, response.text
    assert response.json()["amount"] == "99999999.99"


# --- Снятие с продажи ---------------------------------------------------------


def test_delete_hides_the_solution_and_keeps_the_row(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """«Удаление» — это `is_visible = false`: строку не удаляем."""
    solution = add_solution(db_session, name="Удаляемое")

    response = client.delete(f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS)

    assert response.status_code == 204
    assert response.content == b""

    db_session.expire_all()
    stored = db_session.get(Solution, solution.id)
    assert stored is not None
    assert stored.is_visible is False


def test_deleted_solution_disappears_from_the_shop(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Снятое с продажи решение пропадает из магазина клиента."""
    owner_user = sign_in(client, db_session)
    organizations_for(db_session, owner_user)
    solution = add_solution(db_session)
    assert [item["id"] for item in client.get(CATALOG_URL).json()["items"]] == [solution.id]

    assert client.delete(f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS).status_code == 204

    assert client.get(CATALOG_URL).json()["items"] == []
    # В кабинете оператора строка остаётся: снятая с продажи — не удалённая.
    assert [item["id"] for item in client.get(PLATFORM, headers=OPERATOR_HEADERS).json()] == [
        solution.id
    ]
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS).json()[0]["is_visible"] is False


def test_repeated_delete_is_idempotent(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Повторный `DELETE` по скрытой строке — тот же `204`, а не `404`/`409`."""
    solution = add_solution(db_session, is_visible=False)

    response = client.delete(f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS)

    assert response.status_code == 204
    db_session.expire_all()
    stored = db_session.get(Solution, solution.id)
    assert stored is not None and stored.is_visible is False


def test_delete_of_an_unknown_solution_is_not_found(
    client: TestClient, operator_token: None
) -> None:
    response = client.delete(f"{PLATFORM}/999999", headers=OPERATOR_HEADERS)

    assert response.status_code == 404
    assert response.json() == {"detail": platform_solutions.SOLUTION_NOT_FOUND_DETAIL}


def test_delete_does_not_touch_the_neighbour(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Снятие одной строки не меняет соседнюю и не трогает весь каталог."""
    first = add_solution(db_session, code=JOURNAL_CODE, position=1)
    second = add_solution(db_session, code="telegram_notifications", position=2)

    assert client.delete(f"{PLATFORM}/{first.id}", headers=OPERATOR_HEADERS).status_code == 204

    db_session.expire_all()
    stored = db_session.get(Solution, second.id)
    assert stored is not None and stored.is_visible is True
    # Порядок остался прежним: снятая строка не уехала наверх и не пропала.
    assert [item["id"] for item in client.get(PLATFORM, headers=OPERATOR_HEADERS).json()] == [
        first.id,
        second.id,
    ]


def test_delete_keeps_the_price_of_the_hidden_row(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Снятие с продажи не трогает цену и подпись: строка остаётся той же строкой."""
    solution = add_solution(db_session)

    assert client.delete(f"{PLATFORM}/{solution.id}", headers=OPERATOR_HEADERS).status_code == 204

    body = client.get(PLATFORM, headers=OPERATOR_HEADERS).json()[0]
    assert body["amount"] == "500.00"
    assert body["price_label"] == PRICE_LABEL
