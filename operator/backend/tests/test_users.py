"""Пользователи в кабинете: прокси в основной API и перевод отказов.

Сети нет: HTTP-клиент строится на `httpx.MockTransport` (см. `tests/conftest.py`),
поэтому проверяется ровно то, что кабинет отправляет наверх и что возвращает
вниз. Тексты отказов данных приходят из основного API и обязаны дойти дословно:
кабинет их не собирает и не переписывает.
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
USERS = f"{API}/users"

USER = {
    "id": 142,
    "email": "ivanov@example.com",
    "full_name": "Иванов Иван Иванович",
    "is_active": True,
    "organization_id": 7,
    "organization_name": "ООО Ромашка",
    "role": "owner",
    "created_at": "2026-11-02T10:00:00Z",
}
PAGE = {"items": [USER], "total": 61}


# --- Сессия кабинета --------------------------------------------------------


def test_without_session_every_route_is_unauthorized(client: TestClient) -> None:
    """Сессия кабинета обязательна — сервисный токен её не заменяет."""
    responses = [
        client.get(USERS),
        client.get(f"{USERS}/142"),
        client.patch(f"{USERS}/142", json={"full_name": "Иванов"}),
    ]

    assert [response.status_code for response in responses] == [401, 401, 401]
    for response in responses:
        assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


# --- Список -----------------------------------------------------------------


def test_list_forwards_the_page_and_the_search(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    response = client.get(USERS, params={"limit": 10, "offset": 20, "search": "иван"})

    assert response.status_code == 200, response.text
    assert response.json() == PAGE
    request = main_api.requests[-1]
    assert request.method == "GET"
    assert request.url.path == "/api/platform/users"
    assert request.url.params["limit"] == "10"
    assert request.url.params["offset"] == "20"
    assert request.url.params["search"] == "иван"
    # Кабинет доказывает основному API, что он кабинет, только этим заголовком.
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_list_without_search_does_not_send_the_parameter(
    client: TestClient, main_api: MainApi
) -> None:
    """Параметр необязательный: без него запрос уходит только со страницей."""
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    response = client.get(USERS)

    assert response.status_code == 200, response.text
    params = main_api.requests[-1].url.params
    assert params["limit"] == "50"
    assert params["offset"] == "0"
    assert "search" not in params


def test_card_is_proxied(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=USER)
    login(client)

    response = client.get(f"{USERS}/142")

    assert response.status_code == 200, response.text
    assert response.json() == USER
    assert main_api.requests[-1].url.path == "/api/platform/users/142"


# --- Правка -----------------------------------------------------------------


def test_patch_forwards_only_the_full_name(client: TestClient, main_api: MainApi) -> None:
    """Тело правки — единственное поле: email, роль и активность не уходят."""
    main_api.handler = lambda request: httpx.Response(200, json=USER)
    login(client)

    response = client.patch(f"{USERS}/142", json={"full_name": "Иванов Иван Иванович"})

    assert response.status_code == 200, response.text
    assert response.json() == USER
    request = main_api.requests[-1]
    assert request.method == "PATCH"
    assert request.url.path == "/api/platform/users/142"
    assert json.loads(request.content) == {"full_name": "Иванов Иван Иванович"}
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


# --- Вход под пользователем ---------------------------------------------------
# Кабинет только выдаёт ссылку: адрес сайта знает основной API, а кабинет отдаёт
# его браузеру как есть и своих адресов не строит.

IMPERSONATION_LINK = {"url": "http://stands.example.com/su/eyJhbGciOiJIUzI1NiJ9.eyJ"}


def test_impersonation_link_is_proxied(client: TestClient, main_api: MainApi) -> None:
    """`POST /api/users/{id}/impersonate` уходит наверх без тела и возвращается как есть."""
    main_api.handler = lambda request: httpx.Response(200, json=IMPERSONATION_LINK)
    login(client)

    response = client.post(f"{USERS}/142/impersonate")

    assert response.status_code == 200, response.text
    assert response.json() == IMPERSONATION_LINK
    request = main_api.requests[-1]
    assert request.method == "POST"
    assert request.url.path == "/api/platform/users/142/impersonation-link"
    assert request.content in (b"", b"null")
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_impersonation_link_requires_the_cabinet_session(client: TestClient) -> None:
    """Сервисный токен сессию оператора не заменяет."""
    response = client.post(f"{USERS}/142/impersonate")

    assert response.status_code == 401
    assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


@pytest.mark.parametrize(
    ("status", "detail"),
    [(404, "Пользователь не найден"), (409, "Кабинет не активирован")],
)
def test_impersonation_refusals_are_passed_through(
    client: TestClient, main_api: MainApi, status: int, detail: str
) -> None:
    """Данные отказа приходят из основного API: тот же код и тот же текст."""
    main_api.handler = respond(detail, status)
    login(client)

    response = client.post(f"{USERS}/142/impersonate")

    assert response.status_code == status
    assert response.json() == {"detail": detail}


def test_impersonation_rejected_token_is_a_bad_gateway(
    client: TestClient, main_api: MainApi
) -> None:
    """401 основного API — 502, и оператора из кабинета не выкидывает."""
    main_api.handler = respond("Неверный сервисный токен", 401)
    login(client)

    response = client.post(f"{USERS}/142/impersonate")

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_REJECTED_TOKEN_DETAIL}
    assert client.get(f"{API}/auth/me").status_code == 200


def test_impersonation_network_failure_is_a_bad_gateway(
    client: TestClient, main_api: MainApi
) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети", request=request)

    main_api.handler = boom
    login(client)

    response = client.post(f"{USERS}/142/impersonate")

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_impersonation_with_empty_token_answers_503(
    client: TestClient, empty_token: MainApi
) -> None:
    """Пустой секрет — настройка кабинета: 503 и ни одного запроса наверх."""
    login(client)

    response = client.post(f"{USERS}/142/impersonate")

    assert response.status_code == 503
    assert response.json() == {"detail": OPERATOR_SERVICE_TOKEN_MISSING_DETAIL}
    assert empty_token.requests == []


# --- Перевод отказов основного API ------------------------------------------


def test_not_found_detail_is_passed_through(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = respond("Пользователь не найден", 404)
    login(client)

    response = client.get(f"{USERS}/999999")

    assert response.status_code == 404
    assert response.json() == {"detail": "Пользователь не найден"}


def test_validation_errors_keep_the_list_of_errors(client: TestClient, main_api: MainApi) -> None:
    """`422` основного API — со списком ошибок FastAPI, и он не переписывается."""
    errors = [
        {
            "type": "value_error",
            "loc": ["body", "full_name"],
            "msg": "Value error, ФИО не может быть пустым",
            "input": "   ",
        }
    ]
    main_api.handler = respond(errors, 422)
    login(client)

    response = client.patch(f"{USERS}/142", json={"full_name": "   "})

    assert response.status_code == 422
    assert response.json() == {"detail": errors}


def test_rejected_token_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    """401 основного API — это 502, а не разлогин оператора."""
    main_api.handler = respond("Неверный сервисный токен", 401)
    login(client)

    response = client.get(USERS)

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

    response = client.get(USERS)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_network_failure_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети", request=request)

    main_api.handler = boom
    login(client)

    response = client.get(f"{USERS}/142")

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_timeout_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("слишком долго", request=request)

    main_api.handler = slow
    login(client)

    response = client.patch(f"{USERS}/142", json={"full_name": "Иванов"})

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


# --- Настройка кабинета -----------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", USERS),
        ("get", f"{USERS}/142"),
        ("patch", f"{USERS}/142"),
    ],
)
def test_empty_token_answers_503_without_touching_the_network(
    client: TestClient, empty_token: MainApi, method: str, path: str
) -> None:
    """Пустой секрет — настройка кабинета, а не отказ данных: 503 и ни одного запроса."""
    login(client)

    response = client.request(
        method, path, json={"full_name": "Иванов"} if method == "patch" else None
    )

    assert response.status_code == 503
    assert response.json() == {"detail": OPERATOR_SERVICE_TOKEN_MISSING_DETAIL}
    assert empty_token.requests == []
