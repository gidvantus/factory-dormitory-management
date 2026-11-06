"""Организации в кабинете: прокси в основной API и перевод отказов.

Сети нет: HTTP-клиент строится на `httpx.MockTransport` (см. `tests/conftest.py`),
поэтому проверяется ровно то, что кабинет отправляет наверх и что возвращает
вниз. Тексты отказов данных приходят из основного API и обязаны дойти дословно:
кабинет их не собирает и не переписывает.
"""

import json
from collections.abc import Callable
from typing import Any

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
ORGANIZATIONS = f"{API}/organizations"

DETAILS = {
    "id": 7,
    "name": "ООО Ромашка",
    "inn": "7707083893",
    "kpp": "770701001",
    "ogrn": "1027700132195",
    "address": "г. Москва, ул. Ленина, 1",
    "created_at": "2026-11-02T10:00:00Z",
    "members_count": 2,
    "dormitories_count": 3,
}
PAGE = {
    "items": [
        {
            "id": 7,
            "name": "ООО Ромашка",
            "inn": "7707083893",
            "created_at": "2026-11-02T10:00:00Z",
        }
    ],
    "total": 1,
}


# --- Сессия кабинета --------------------------------------------------------


def test_without_session_every_route_is_unauthorized(client: TestClient) -> None:
    """Сессия кабинета обязательна — сервисный токен её не заменяет."""
    responses = [
        client.get(ORGANIZATIONS),
        client.get(f"{ORGANIZATIONS}/7"),
        client.patch(f"{ORGANIZATIONS}/7", json={"name": "ООО"}),
        # Раздел тарифа и расширений (#189): те же четыре ручки, но через прокси.
        client.get(f"{ORGANIZATIONS}/7/subscription"),
        client.patch(f"{ORGANIZATIONS}/7/subscription", json={"paid_until": "2027-06-30"}),
        client.post(f"{ORGANIZATIONS}/7/subscription/deactivate"),
        client.post(f"{ORGANIZATIONS}/7/solutions/journal/deactivate"),
    ]

    assert [response.status_code for response in responses] == [401] * 7
    for response in responses:
        assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


# --- Список -----------------------------------------------------------------


def test_list_is_proxied(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    response = client.get(ORGANIZATIONS, params={"limit": 10, "offset": 20})

    assert response.status_code == 200, response.text
    assert response.json() == PAGE
    request = main_api.requests[-1]
    assert request.method == "GET"
    assert request.url.path == "/api/platform/organizations"
    assert request.url.params["limit"] == "10"
    assert request.url.params["offset"] == "20"
    # Кабинет доказывает основному API, что он кабинет, только этим заголовком.
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_list_uses_the_default_page(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    response = client.get(ORGANIZATIONS)

    assert response.status_code == 200, response.text
    params = main_api.requests[-1].url.params
    assert params["limit"] == "50"
    assert params["offset"] == "0"


def test_card_is_proxied(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=DETAILS)
    login(client)

    response = client.get(f"{ORGANIZATIONS}/7")

    assert response.status_code == 200, response.text
    assert response.json() == DETAILS
    assert main_api.requests[-1].url.path == "/api/platform/organizations/7"


# --- Правка -----------------------------------------------------------------


def test_patch_forwards_only_the_fields_it_was_given(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=DETAILS)
    login(client)

    response = client.patch(f"{ORGANIZATIONS}/7", json={"address": "г. Москва"})

    assert response.status_code == 200, response.text
    assert response.json() == DETAILS
    request = main_api.requests[-1]
    assert request.method == "PATCH"
    assert request.url.path == "/api/platform/organizations/7"
    # Отсутствующие поля наверх не уходят: иначе правка адреса обнулила бы
    # название, а правило это — основного API.
    assert json.loads(request.content) == {"address": "г. Москва"}
    assert OPERATOR_TOKEN_HEADER in request.headers


def test_patch_forwards_an_explicit_null(client: TestClient, main_api: MainApi) -> None:
    """`name: null` уходит наверх: отказ по нему — правило основного API."""
    main_api.handler = lambda request: httpx.Response(
        422, json={"detail": "Название не может быть пустым"}
    )
    login(client)

    response = client.patch(f"{ORGANIZATIONS}/7", json={"name": None})

    assert response.status_code == 422
    assert json.loads(main_api.requests[-1].content) == {"name": None}


# --- Перевод отказов основного API ------------------------------------------


@pytest.mark.parametrize(
    ("status_code", "detail"),
    [
        (404, "Организация не найдена"),
        (409, "Организация с таким ИНН уже есть"),
    ],
)
def test_data_refusals_are_passed_through(
    client: TestClient,
    main_api: MainApi,
    status_code: int,
    detail: str,
) -> None:
    main_api.handler = respond(detail, status_code)
    login(client)

    response = client.get(f"{ORGANIZATIONS}/7")

    assert response.status_code == status_code
    assert response.json() == {"detail": detail}


def test_validation_errors_keep_the_list_of_errors(client: TestClient, main_api: MainApi) -> None:
    """`422` основного API — со списком ошибок FastAPI, и он не переписывается."""
    errors = [
        {
            "type": "value_error",
            "loc": ["body", "inn"],
            "msg": "Value error, ИНН должен состоять из 10 или 12 цифр",
            "input": "12345",
        }
    ]
    main_api.handler = respond(errors, 422)
    login(client)

    response = client.patch(f"{ORGANIZATIONS}/7", json={"inn": "12345"})

    assert response.status_code == 422
    assert response.json() == {"detail": errors}


def test_rejected_token_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    """401 основного API — это 502, а не разлогин оператора."""
    main_api.handler = respond("Неверный сервисный токен", 401)
    login(client)

    response = client.get(ORGANIZATIONS)

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

    response = client.get(ORGANIZATIONS)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_network_failure_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети", request=request)

    main_api.handler = boom
    login(client)

    response = client.get(f"{ORGANIZATIONS}/7")

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_timeout_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("слишком долго", request=request)

    main_api.handler = slow
    login(client)

    response = client.patch(f"{ORGANIZATIONS}/7", json={"name": "ООО"})

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


# --- Настройка кабинета -----------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", ORGANIZATIONS),
        ("get", f"{ORGANIZATIONS}/7"),
        ("patch", f"{ORGANIZATIONS}/7"),
    ],
)
def test_empty_token_answers_503_without_touching_the_network(
    client: TestClient, empty_token: MainApi, method: str, path: str
) -> None:
    """Пустой секрет — настройка кабинета, а не отказ данных: 503 и ни одного запроса."""
    login(client)

    response = client.request(method, path, json={"name": "ООО"} if method == "patch" else None)

    assert response.status_code == 503
    assert response.json() == {"detail": OPERATOR_SERVICE_TOKEN_MISSING_DETAIL}
    assert empty_token.requests == []


# --- Тариф и расширения организации (#189) -----------------------------------
# Четыре ручки раздела: чтение, правка срока и два снятия активности. Все они
# отвечают одним объектом состояния, и кабинет его не собирает — только передаёт
# ответ основного API. Значения полей здесь не проверяются и не приводятся:
# формат даты — правило основного API, и его `422` уходит клиенту дословно.

SUBSCRIPTION = f"{ORGANIZATIONS}/7/subscription"
SOLUTION = f"{ORGANIZATIONS}/7/solutions/journal/deactivate"
MAIN_API_SUBSCRIPTION = "/api/platform/organizations/7/subscription"
MAIN_API_SOLUTION = "/api/platform/organizations/7/solutions/journal/deactivate"

# Состояние подписки — образец ответа основного API. Аннотации `dict[str, Any]`
# нужны, чтобы тесты могли собирать из него варианты по полям: без них mypy
# считает `STATE["solutions"]` объектом и запрещает индексацию элемента списка.
TARIFF: dict[str, Any] = {
    "id": 4,
    "name": "Домовой · 12 месяцев",
    "period": "year",
    "max_members": 5,
    "price_label": "10 000 ₽ в год",
    "ends_at": "2027-06-30T20:59:59.999999Z",
    "paid_until": "2027-06-30",
    "is_live": True,
}
# Право на расширение: бессрочное, поэтому `expires_at` и `paid_until` пусты.
SOLUTION_RIGHT: dict[str, Any] = {
    "code": "journal",
    "name": "Журнал действий",
    "expires_at": None,
    "paid_until": None,
    "is_live": True,
}
STATE: dict[str, Any] = {
    "tariff": TARIFF,
    "days_left": 236,
    "next": None,
    "extra_seats": 3,
    "member_limit": 8,
    "solutions": [SOLUTION_RIGHT],
}
PAID_UNTIL_MESSAGE = "Укажите срок действия в формате ГГГГ-ММ-ДД"
# Текст отказа основного API на слот без тарифа (ревью №1, Б1): кабинет его не
# объявляет, а передаёт — здесь копия нужна только для ожидания в тесте.
TARIFF_NOT_ASSIGNED_DETAIL = "Тариф не назначен"
DATE_ERRORS = [
    {
        "type": "value_error",
        "loc": ["body", "paid_until"],
        "msg": f"Value error, {PAID_UNTIL_MESSAGE}",
        "input": "31.02.2027",
    }
]


def test_subscription_is_proxied(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=STATE)
    login(client)

    response = client.get(SUBSCRIPTION)

    assert response.status_code == 200, response.text
    assert response.json() == STATE
    request = main_api.requests[-1]
    assert request.method == "GET"
    assert request.url.path == MAIN_API_SUBSCRIPTION
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_subscription_patch_forwards_the_date(client: TestClient, main_api: MainApi) -> None:
    """Ответ на правку — состояние из основного API, а не эхо присланного тела."""
    updated = {**STATE, "days_left": 371}
    main_api.handler = lambda request: httpx.Response(200, json=updated)
    login(client)

    response = client.patch(SUBSCRIPTION, json={"paid_until": "2027-06-30"})

    assert response.status_code == 200, response.text
    assert response.json() == updated
    request = main_api.requests[-1]
    assert request.method == "PATCH"
    assert request.url.path == MAIN_API_SUBSCRIPTION
    assert json.loads(request.content) == {"paid_until": "2027-06-30"}


def test_subscription_patch_forwards_an_empty_body(client: TestClient, main_api: MainApi) -> None:
    """Пустое тело уходит наверх как есть: «поле обязательно» — правило основного API."""
    main_api.handler = respond(DATE_ERRORS, 422)
    login(client)

    response = client.patch(SUBSCRIPTION, json={})

    assert response.status_code == 422
    assert json.loads(main_api.requests[-1].content) == {}


def test_subscription_patch_does_not_validate_or_coerce_the_date(
    client: TestClient, main_api: MainApi
) -> None:
    """Кабинет не подменяет отказ основного API своим английским текстом.

    С `paid_until: str` в схеме `pydantic` отклонил бы число или `null` на своей
    стороне — английским сообщением, — а контракт обещает русский текст из
    основного API. Поэтому значение уходит наверх дословно, и тело это доказывает:
    приведённое значение выдало бы себя.
    """
    main_api.handler = respond(DATE_ERRORS, 422)
    login(client)

    numeric = client.patch(SUBSCRIPTION, json={"paid_until": 20270630})
    empty = client.patch(SUBSCRIPTION, json={"paid_until": None})

    assert numeric.status_code == 422
    assert numeric.json() == {"detail": DATE_ERRORS}
    assert json.loads(main_api.requests[-2].content) == {"paid_until": 20270630}
    assert empty.status_code == 422
    assert json.loads(main_api.requests[-1].content) == {"paid_until": None}


def test_subscription_deactivate_is_posted(client: TestClient, main_api: MainApi) -> None:
    """Команда снятия — `POST` без тела и с ответом-состоянием, а не `204`."""
    deactivated = {**STATE, "tariff": {**TARIFF, "is_live": False}, "days_left": 0}
    main_api.handler = lambda request: httpx.Response(200, json=deactivated)
    login(client)

    response = client.post(f"{SUBSCRIPTION}/deactivate")

    assert response.status_code == 200, response.text
    assert response.json() == deactivated
    request = main_api.requests[-1]
    assert request.method == "POST"
    assert request.url.path == f"{MAIN_API_SUBSCRIPTION}/deactivate"
    assert request.content == b""


def test_solution_deactivate_is_posted(client: TestClient, main_api: MainApi) -> None:
    off = {**STATE, "solutions": [{**STATE["solutions"][0], "is_live": False}]}
    main_api.handler = lambda request: httpx.Response(200, json=off)
    login(client)

    response = client.post(SOLUTION)

    assert response.status_code == 200, response.text
    assert response.json() == off
    request = main_api.requests[-1]
    assert request.method == "POST"
    assert request.url.path == MAIN_API_SOLUTION


@pytest.mark.parametrize(
    ("method", "path", "payload", "detail"),
    [
        ("get", SUBSCRIPTION, None, "Организация не найдена"),
        ("patch", SUBSCRIPTION, {"paid_until": "2027-06-30"}, "Организация не найдена"),
        ("post", f"{SUBSCRIPTION}/deactivate", None, "Организация не найдена"),
        ("post", SOLUTION, None, "Расширение не найдено"),
    ],
)
def test_subscription_refusals_are_passed_through(
    client: TestClient,
    main_api: MainApi,
    method: str,
    path: str,
    payload: dict[str, str] | None,
    detail: str,
) -> None:
    """Тексты отказов — часть контракта: кабинет их не переписывает."""
    main_api.handler = respond(detail, 404)
    login(client)

    response = client.request(method, path, json=payload)

    assert response.status_code == 404
    assert response.json() == {"detail": detail}


def test_subscription_validation_errors_keep_the_list(
    client: TestClient, main_api: MainApi
) -> None:
    """`422` основного API — список ошибок FastAPI, и он уходит дословно."""
    main_api.handler = respond(DATE_ERRORS, 422)
    login(client)

    response = client.patch(SUBSCRIPTION, json={"paid_until": "31.02.2027"})

    assert response.status_code == 422
    assert response.json() == {"detail": DATE_ERRORS}


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", SUBSCRIPTION, None),
        ("patch", SUBSCRIPTION, {"paid_until": "2027-06-30"}),
        ("post", f"{SUBSCRIPTION}/deactivate", None),
        ("post", SOLUTION, None),
    ],
)
def test_subscription_rejected_token_is_a_bad_gateway(
    client: TestClient, main_api: MainApi, method: str, path: str, payload: dict[str, str] | None
) -> None:
    """`401` основного API — это `502`: кабинет не принял токен, а не сессия истекла."""
    main_api.handler = respond("Неверный сервисный токен", 401)
    login(client)

    response = client.request(method, path, json=payload)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_REJECTED_TOKEN_DETAIL}


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", SUBSCRIPTION, None),
        ("patch", SUBSCRIPTION, {"paid_until": "2027-06-30"}),
        ("post", f"{SUBSCRIPTION}/deactivate", None),
        ("post", SOLUTION, None),
    ],
)
def test_subscription_empty_token_answers_503(
    client: TestClient, empty_token: MainApi, method: str, path: str, payload: dict[str, str] | None
) -> None:
    """Пустой секрет — настройка кабинета: `503` без похода в сеть."""
    login(client)

    response = client.request(method, path, json=payload)

    assert response.status_code == 503
    assert response.json() == {"detail": OPERATOR_SERVICE_TOKEN_MISSING_DETAIL}
    assert empty_token.requests == []


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("patch", SUBSCRIPTION, {"paid_until": "2027-06-30"}),
        ("post", f"{SUBSCRIPTION}/deactivate", None),
    ],
)
def test_subscription_refuses_a_slot_without_a_tariff(
    client: TestClient, main_api: MainApi, method: str, path: str, payload: dict[str, str] | None
) -> None:
    """`409 «Тариф не назначен»` (ревью №1, Б1) проходит насквозь, как и прочие отказы.

    Кабинет его не переписывает и не превращает в успех: фронтенд показывает
    `detail` в `role="alert"`.
    """
    main_api.handler = respond(TARIFF_NOT_ASSIGNED_DETAIL, 409)
    login(client)

    response = client.request(method, path, json=payload)

    assert response.status_code == 409
    assert response.json() == {"detail": TARIFF_NOT_ASSIGNED_DETAIL}
