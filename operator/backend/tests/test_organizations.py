"""Организации в кабинете: прокси в основной API и перевод отказов.

Сети нет: HTTP-клиент строится на `httpx.MockTransport` (см. `tests/conftest.py`),
поэтому проверяется ровно то, что кабинет отправляет наверх и что возвращает
вниз. Тексты отказов данных приходят из основного API и обязаны дойти дословно:
кабинет их не собирает и не переписывает.
"""

import json
from collections.abc import Callable, Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api.organizations import (
    MAIN_API_REJECTED_TOKEN_DETAIL,
    MAIN_API_UNAVAILABLE_DETAIL,
    OPERATOR_SERVICE_TOKEN_MISSING_DETAIL,
    OPERATOR_TOKEN_HEADER,
    main_api_client,
)
from app.config import get_settings
from app.main import app
from app.security import UNAUTHORIZED_DETAIL
from tests.conftest import (
    TEST_OPERATOR_PASSWORD,
    TEST_OPERATOR_USERNAME,
)

SERVICE_TOKEN = "unit-test-operator-service-token"
BASE_URL = "http://api.test"
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


class MainApi:
    """Подставной основной API: запоминает запросы и отвечает заданным."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.handler: Callable[[httpx.Request], httpx.Response] = lambda request: httpx.Response(
            200, json=PAGE
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)


@pytest.fixture
def main_api(monkeypatch: pytest.MonkeyPatch, settings_cache: None) -> Iterator[MainApi]:
    """Основной API подменён транспортом, а секрет контура выставлен явно.

    Клиент создаётся в зависимости (`main_api_client`), поэтому тест подменяет
    саму зависимость: глобального клиента в модуле нет и подменять нечего.
    """
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    api = MainApi()

    def _client() -> Iterator[httpx.Client]:
        with httpx.Client(
            transport=httpx.MockTransport(api.handle),
            base_url=BASE_URL,
        ) as client:
            yield client

    app.dependency_overrides[main_api_client] = _client
    try:
        yield api
    finally:
        app.dependency_overrides.pop(main_api_client, None)
        get_settings.cache_clear()


@pytest.fixture
def empty_token(monkeypatch: pytest.MonkeyPatch, settings_cache: None) -> Iterator[MainApi]:
    """Пустой секрет контура: кабинет отвечает 503 и в сеть не идёт."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", "")
    get_settings.cache_clear()
    api = MainApi()

    def _client() -> Iterator[httpx.Client]:
        with httpx.Client(
            transport=httpx.MockTransport(api.handle),
            base_url=BASE_URL,
        ) as client:
            yield client

    app.dependency_overrides[main_api_client] = _client
    try:
        yield api
    finally:
        app.dependency_overrides.pop(main_api_client, None)
        get_settings.cache_clear()


def login(client: TestClient) -> None:
    """Войти оператором: ручки организаций закрыты сессией кабинета."""
    response = client.post(
        f"{API}/auth/login",
        json={"username": TEST_OPERATOR_USERNAME, "password": TEST_OPERATOR_PASSWORD},
    )
    assert response.status_code == 200, response.text


def respond(detail: object, status_code: int) -> Callable[[httpx.Request], httpx.Response]:
    """Обработчик, отвечающий заданным отказом основного API."""
    return lambda request: httpx.Response(status_code, json={"detail": detail})


# --- Сессия кабинета --------------------------------------------------------


def test_without_session_every_route_is_unauthorized(client: TestClient) -> None:
    """Сессия кабинета обязательна — сервисный токен её не заменяет."""
    responses = [
        client.get(ORGANIZATIONS),
        client.get(f"{ORGANIZATIONS}/7"),
        client.patch(f"{ORGANIZATIONS}/7", json={"name": "ООО"}),
    ]

    assert [response.status_code for response in responses] == [401, 401, 401]
    for response in responses:
        assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


# --- Список -----------------------------------------------------------------


def test_list_is_proxied(client: TestClient, main_api: MainApi) -> None:
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
