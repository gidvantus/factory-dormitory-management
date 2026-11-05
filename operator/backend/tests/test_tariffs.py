"""Тарифы в кабинете оператора: прокси в основной API и перевод отказов.

Сети нет: HTTP-клиент строится на `httpx.MockTransport` (см. `tests/conftest.py`),
поэтому проверяется ровно то, что кабинет отправляет наверх и что возвращает
вниз. Тексты отказов данных приходят из основного API и обязаны дойти дословно:
кабинет их не собирает и не переписывает.

Отдельно проверяется расширение общего `call()` до `204` (#178): снятие тарифа с
продажи — команда без тела, и раньше она превращалась бы в `502`. При этом
успехом по-прежнему считается только `200` и `204`: `201` от основного API —
расхождение контракта, а не успех.
"""

import json
from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main_api import (
    MAIN_API_REJECTED_TOKEN_DETAIL,
    MAIN_API_UNAVAILABLE_DETAIL,
    OPERATOR_SERVICE_TOKEN_MISSING_DETAIL,
    OPERATOR_TOKEN_HEADER,
)
from app.security import UNAUTHORIZED_DETAIL
from tests.conftest import SERVICE_TOKEN, MainApi, login, respond

API = "/api"
TARIFFS = f"{API}/tariffs"
PLATFORM_PATH = "/api/platform/tariffs"

TARIFF = {
    "id": 7,
    "name": "Старт · 3 месяца",
    "description": "До 5 пользователей",
    "amount": "13200.00",
    "currency": "RUB",
    "period": "quarter",
    "unit_label": "за одно место",
    "position": 3,
    "is_visible": True,
    "max_members": 5,
    "tooltip": "Место — сотрудник с доступом к кабинету",
    "group_code": "start",
    "price_label": "13 200 ₽ за одно место за 3 месяца",
}

HIDDEN_TARIFF = {
    **TARIFF,
    "id": 8,
    "name": "Снятый",
    "is_visible": False,
    "max_members": None,
}

PRICE_LIST = [TARIFF, HIDDEN_TARIFF]


# --- Сессия кабинета --------------------------------------------------------


def test_without_session_every_route_is_unauthorized(client: TestClient) -> None:
    """Сессия кабинета обязательна — сервисный токен её не заменяет."""
    responses = [
        client.get(TARIFFS),
        client.patch(f"{TARIFFS}/7", json={"name": "Новое"}),
        client.delete(f"{TARIFFS}/7"),
    ]

    assert [response.status_code for response in responses] == [401, 401, 401]
    for response in responses:
        assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


# --- Список -----------------------------------------------------------------


def test_list_forwards_to_the_platform_price_list(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=PRICE_LIST)
    login(client)

    response = client.get(TARIFFS)

    assert response.status_code == 200, response.text
    assert response.json() == PRICE_LIST
    request = main_api.requests[-1]
    assert request.method == "GET"
    assert request.url.path == PLATFORM_PATH
    # Кабинет доказывает основному API, что он кабинет, только этим заголовком.
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_list_keeps_hidden_rows_and_the_price_label(client: TestClient, main_api: MainApi) -> None:
    """Скрытые строки кабинет не отфильтровывает: это делает только публичный прайс."""
    main_api.handler = lambda request: httpx.Response(200, json=PRICE_LIST)
    login(client)

    body = client.get(TARIFFS).json()

    assert [item["is_visible"] for item in body] == [True, False]
    # `price_label` приходит готовым: кабинет формулу цены не повторяет.
    assert body[0]["price_label"] == "13 200 ₽ за одно место за 3 месяца"
    assert body[1]["max_members"] is None


# --- Правка -----------------------------------------------------------------


def test_patch_forwards_only_the_sent_fields(client: TestClient, main_api: MainApi) -> None:
    """Тело правки уходит наверх как есть: непереданные поля не обнуляются."""
    main_api.handler = lambda request: httpx.Response(200, json=TARIFF)
    login(client)

    response = client.patch(f"{TARIFFS}/7", json={"description": "Новое описание"})

    assert response.status_code == 200, response.text
    assert response.json() == TARIFF
    request = main_api.requests[-1]
    assert request.method == "PATCH"
    assert request.url.path == f"{PLATFORM_PATH}/7"
    assert json.loads(request.content) == {"description": "Новое описание"}
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_patch_publishes_a_hidden_tariff(client: TestClient, main_api: MainApi) -> None:
    """«Опубликовать» — это `PATCH {"is_visible": true}`, и тело не переписывается."""
    published = {**TARIFF, "is_visible": True}
    main_api.handler = lambda request: httpx.Response(200, json=published)
    login(client)

    response = client.patch(f"{TARIFFS}/8", json={"is_visible": True})

    assert response.status_code == 200, response.text
    assert response.json()["is_visible"] is True
    assert json.loads(main_api.requests[-1].content) == {"is_visible": True}


def test_patch_brings_the_recalculated_price_label(client: TestClient, main_api: MainApi) -> None:
    """`price_label` пересчитывает основной API: кабинет его не собирает."""
    repriced = {**TARIFF, "amount": "4900.00", "period": "year", "price_label": "4 900 ₽ в год"}
    main_api.handler = lambda request: httpx.Response(200, json=repriced)
    login(client)

    body = client.patch(f"{TARIFFS}/7", json={"amount": "4900.00", "period": "year"}).json()

    assert body["price_label"] == "4 900 ₽ в год"
    assert body["amount"] == "4900.00"


# --- Снятие с продажи -------------------------------------------------------


def test_delete_answers_204_without_a_body(client: TestClient, main_api: MainApi) -> None:
    """`DELETE` основного API отвечает `204`: кабинет отдаёт его без тела.

    Это и есть проверка расширения общего `call()`: пока успехом считался только
    `200`, пустой ответ основного API превращался в `502 «Основной API
    недоступен»`.
    """
    main_api.handler = lambda request: httpx.Response(204)
    login(client)

    response = client.delete(f"{TARIFFS}/7")

    assert response.status_code == 204
    assert response.content == b""
    request = main_api.requests[-1]
    assert request.method == "DELETE"
    assert request.url.path == f"{PLATFORM_PATH}/7"
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_repeated_delete_is_idempotent(client: TestClient, main_api: MainApi) -> None:
    """Повторный `DELETE` — тот же `204`: основной API не различает состояния."""
    main_api.handler = lambda request: httpx.Response(204)
    login(client)

    assert client.delete(f"{TARIFFS}/7").status_code == 204
    assert client.delete(f"{TARIFFS}/7").status_code == 204


def test_other_success_codes_are_not_success(client: TestClient, main_api: MainApi) -> None:
    """Расширение до `204` не сделало успехом любой `2xx`: `201` — это `502`."""
    main_api.handler = lambda request: httpx.Response(201, json={"id": 9})
    login(client)

    response = client.get(TARIFFS)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


# --- Перевод отказов основного API ------------------------------------------


def test_not_found_detail_is_passed_through(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = respond("Тариф не найден", 404)
    login(client)

    response = client.patch(f"{TARIFFS}/7", json={"name": "Новое"})

    assert response.status_code == 404
    assert response.json() == {"detail": "Тариф не найден"}


def test_conflict_detail_is_passed_through(client: TestClient, main_api: MainApi) -> None:
    """Занятое имя — текст основного API, дословно: кабинет его не переписывает."""
    main_api.handler = respond("Тариф с таким названием уже есть", 409)
    login(client)

    response = client.patch(f"{TARIFFS}/7", json={"name": "РОСТ"})

    assert response.status_code == 409
    assert response.json() == {"detail": "Тариф с таким названием уже есть"}


def test_validation_errors_keep_the_list_of_errors(client: TestClient, main_api: MainApi) -> None:
    """`422` основного API — со списком ошибок FastAPI, и он не переписывается."""
    errors = [
        {
            "type": "value_error",
            "loc": ["body", "name"],
            "msg": "Value error, Название не может быть пустым",
            "input": "   ",
        }
    ]
    main_api.handler = respond(errors, 422)
    login(client)

    response = client.patch(f"{TARIFFS}/7", json={"name": "   "})

    assert response.status_code == 422
    assert response.json() == {"detail": errors}


def test_delete_of_an_unknown_tariff_is_not_found(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = respond("Тариф не найден", 404)
    login(client)

    response = client.delete(f"{TARIFFS}/999999")

    assert response.status_code == 404
    assert response.json() == {"detail": "Тариф не найден"}


def test_rejected_token_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    """401 основного API — это 502, а не разлогин оператора."""
    main_api.handler = respond("Неверный сервисный токен", 401)
    login(client)

    response = client.get(TARIFFS)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_REJECTED_TOKEN_DETAIL}
    # Сессия кабинета остаётся: оператору не надо входить заново.
    assert client.get(f"{API}/auth/me").status_code == 200


@pytest.mark.parametrize(
    "handler",
    [
        lambda request: httpx.Response(500, json={"detail": "boom"}),
        lambda request: httpx.Response(503),
    ],
)
def test_server_errors_are_a_bad_gateway(
    client: TestClient, main_api: MainApi, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    main_api.handler = handler
    login(client)

    response = client.get(TARIFFS)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_network_failure_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети", request=request)

    main_api.handler = boom
    login(client)

    response = client.delete(f"{TARIFFS}/7")

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_timeout_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("слишком долго", request=request)

    main_api.handler = slow
    login(client)

    response = client.patch(f"{TARIFFS}/7", json={"name": "Новое"})

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


# --- Настройка кабинета -----------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", TARIFFS, None),
        ("patch", f"{TARIFFS}/7", {"name": "Новое"}),
        ("delete", f"{TARIFFS}/7", None),
    ],
)
def test_empty_token_answers_503_without_touching_the_network(
    client: TestClient,
    empty_token: MainApi,
    method: str,
    path: str,
    payload: dict[str, str] | None,
) -> None:
    """Пустой секрет — настройка кабинета, а не отказ данных: 503 и ни одного запроса."""
    login(client)

    response = client.request(method, path, json=payload)

    assert response.status_code == 503
    assert response.json() == {"detail": OPERATOR_SERVICE_TOKEN_MISSING_DETAIL}
    assert empty_token.requests == []
