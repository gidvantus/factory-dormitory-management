"""Реквизиты поставщика в кабинете оператора: прокси в основной API (issue #179).

Сети нет: HTTP-клиент строится на `httpx.MockTransport` (см. `tests/conftest.py`),
поэтому проверяется ровно то, что кабинет отправляет наверх и что возвращает
вниз.

* без cookie сессии обе ручки — `401` с текстом кабинета;
* `GET` идёт на `/api/platform/company-details` с сервисным токеном и отдаёт
  ответ основного API дословно, включая пустые значения `null`;
* `PATCH` передаёт **только присланные** поля: правка строки про НДС не обнуляет
  банк, а пустая строка уходит как есть — правило «пустое значит `null`» живёт в
  основном API;
* `422` основного API проходит со списком ошибок и его текстами — кабинет их не
  переписывает;
* пустой `OPERATOR_SERVICE_TOKEN` — `503` без запроса в сеть, `5xx` и сетевой
  сбой — `502 «Основной API недоступен»`.
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
COMPANY = f"{API}/company-details"
PLATFORM_PATH = "/api/platform/company-details"

COMPANY_DETAILS = {
    "id": 1,
    "name": "ООО «Домовой»",
    "inn": "7701234567",
    "kpp": "770101001",
    "ogrn": "1027700132195",
    "address": "г. Москва, ул. Тверская, д. 1",
    "bank_name": "ПАО «Банк»",
    "bank_bic": "044525225",
    "bank_account": "40702810100000000001",
    "corr_account": "30101810400000000225",
    "signatory": "Директор Петров П. П.",
    "vat_note": "НДС не облагается",
    "updated_at": "2026-11-05T12:00:00Z",
}

EMPTY_COMPANY_DETAILS = {
    "id": 1,
    "name": None,
    "inn": None,
    "kpp": None,
    "ogrn": None,
    "address": None,
    "bank_name": None,
    "bank_bic": None,
    "bank_account": None,
    "corr_account": None,
    "signatory": None,
    "vat_note": None,
    "updated_at": None,
}


# --- Сессия кабинета --------------------------------------------------------


def test_without_session_every_route_is_unauthorized(client: TestClient) -> None:
    """Сессия кабинета обязательна — сервисный токен её не заменяет."""
    responses = [
        client.get(COMPANY),
        client.patch(COMPANY, json={"vat_note": "НДС не облагается"}),
    ]

    assert [response.status_code for response in responses] == [401, 401]
    for response in responses:
        assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


# --- Чтение -----------------------------------------------------------------


def test_get_forwards_to_the_platform_route(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=COMPANY_DETAILS)
    login(client)

    response = client.get(COMPANY)

    assert response.status_code == 200, response.text
    assert response.json() == COMPANY_DETAILS
    request = main_api.requests[-1]
    assert request.method == "GET"
    assert request.url.path == PLATFORM_PATH
    # Кабинет доказывает основному API, что он кабинет, только этим заголовком.
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_get_keeps_the_empty_answer_as_is(client: TestClient, main_api: MainApi) -> None:
    """Пустые реквизиты — `200` с `null`, а не `404`: экран показывает пустую форму."""
    main_api.handler = lambda request: httpx.Response(200, json=EMPTY_COMPANY_DETAILS)
    login(client)

    response = client.get(COMPANY)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] is None
    assert body["vat_note"] is None
    assert body["updated_at"] is None
    # Все поля на месте: экран не различает «поле не пришло» и «поле пустое».
    assert set(body) == set(EMPTY_COMPANY_DETAILS)


# --- Правка -----------------------------------------------------------------


def test_patch_forwards_only_the_sent_fields(client: TestClient, main_api: MainApi) -> None:
    """Тело правки уходит наверх как есть: непереданные поля не обнуляются."""
    main_api.handler = lambda request: httpx.Response(200, json=COMPANY_DETAILS)
    login(client)

    response = client.patch(COMPANY, json={"name": "ООО «Домовой»", "inn": "7701234567"})

    assert response.status_code == 200, response.text
    assert response.json() == COMPANY_DETAILS
    request = main_api.requests[-1]
    assert request.method == "PATCH"
    assert request.url.path == PLATFORM_PATH
    assert json.loads(request.content) == {"name": "ООО «Домовой»", "inn": "7701234567"}
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_patch_forwards_an_empty_string_as_is(client: TestClient, main_api: MainApi) -> None:
    """Очистку поля решает основной API: кабинет пустую строку не переписывает в `null`."""
    cleared = {**COMPANY_DETAILS, "vat_note": None}
    main_api.handler = lambda request: httpx.Response(200, json=cleared)
    login(client)

    response = client.patch(COMPANY, json={"vat_note": ""})

    assert response.status_code == 200, response.text
    assert response.json()["vat_note"] is None
    assert json.loads(main_api.requests[-1].content) == {"vat_note": ""}


def test_patch_forwards_a_null_as_is(client: TestClient, main_api: MainApi) -> None:
    cleared = {**COMPANY_DETAILS, "signatory": None}
    main_api.handler = lambda request: httpx.Response(200, json=cleared)
    login(client)

    response = client.patch(COMPANY, json={"signatory": None})

    assert response.status_code == 200, response.text
    assert json.loads(main_api.requests[-1].content) == {"signatory": None}


# --- Перевод отказов основного API ------------------------------------------


def test_validation_errors_keep_the_list_of_errors(client: TestClient, main_api: MainApi) -> None:
    """`422` основного API — со списком ошибок FastAPI, и он не переписывается."""
    errors = [
        {
            "type": "value_error",
            "loc": ["body", "vat_note"],
            "msg": "Value error, Строка про НДС длиннее 200 символов",
            "input": "я" * 201,
        }
    ]
    main_api.handler = respond(errors, 422)
    login(client)

    response = client.patch(COMPANY, json={"vat_note": "я" * 201})

    assert response.status_code == 422
    assert response.json() == {"detail": errors}


def test_missing_row_is_passed_through(client: TestClient, main_api: MainApi) -> None:
    """`404` основного API доходит дословно: создавать строку кабинет не пытается."""
    main_api.handler = respond("Реквизиты поставщика не заведены", 404)
    login(client)

    response = client.patch(COMPANY, json={"name": "ООО «Домовой»"})

    assert response.status_code == 404
    assert response.json() == {"detail": "Реквизиты поставщика не заведены"}


def test_rejected_token_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    """401 основного API — это 502, а не разлогин оператора."""
    main_api.handler = respond("Неверный сервисный токен", 401)
    login(client)

    response = client.get(COMPANY)

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

    response = client.patch(COMPANY, json={"name": "ООО «Домовой»"})

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_network_failure_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети", request=request)

    main_api.handler = boom
    login(client)

    response = client.get(COMPANY)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


# --- Настройка кабинета -----------------------------------------------------


@pytest.mark.parametrize(
    ("method", "payload"),
    [
        ("get", None),
        ("patch", {"name": "ООО «Домовой»"}),
    ],
)
def test_empty_token_answers_503_without_touching_the_network(
    client: TestClient,
    empty_token: MainApi,
    method: str,
    payload: dict[str, str] | None,
) -> None:
    """Пустой секрет — настройка кабинета, а не отказ данных: 503 и ни одного запроса."""
    login(client)

    response = client.request(method, COMPANY, json=payload)

    assert response.status_code == 503
    assert response.json() == {"detail": OPERATOR_SERVICE_TOKEN_MISSING_DETAIL}
    assert empty_token.requests == []
