"""Решения магазина в кабинете оператора: прокси в основной API и перевод отказов (#188).

Сети нет: HTTP-клиент строится на `httpx.MockTransport` (см. `tests/conftest.py`),
поэтому проверяется ровно то, что кабинет отправляет наверх и что возвращает
вниз. Тексты отказов данных приходят из основного API и обязаны дойти дословно:
кабинет их не собирает и не переписывает.

Своих правил правки у кабинета нет намеренно: тело `PATCH` уходит наверх как есть,
включая лишние поля (`code`, например) — их разбирает основной API и отвечает на
них своим `422`. Поэтому проверяется и это: прокси не должен ничего отсеивать.
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
SOLUTIONS = f"{API}/solutions"
PLATFORM_PATH = "/api/platform/solutions"

SOLUTION = {
    "id": 3,
    "code": "telegram_notifications",
    "name": "Уведомления в Telegram",
    "description": "Сообщения о событиях, которые вас касаются",
    "amount": "500.00",
    "currency": "RUB",
    "position": 1,
    "is_visible": True,
    "price_label": "500 ₽ разово",
    "created_at": "2026-01-01T00:00:00",
    "updated_at": "2026-01-02T00:00:00",
}

HIDDEN_SOLUTION = {
    **SOLUTION,
    "id": 4,
    "code": "journal",
    "name": "Журнал действий",
    "description": None,
    "amount": "300.00",
    "position": 2,
    "is_visible": False,
    "price_label": "300 ₽ разово",
}

CATALOG = [SOLUTION, HIDDEN_SOLUTION]


# --- Сессия кабинета --------------------------------------------------------


def test_without_session_every_route_is_unauthorized(client: TestClient) -> None:
    """Сессия кабинета обязательна — сервисный токен её не заменяет."""
    responses = [
        client.get(SOLUTIONS),
        client.patch(f"{SOLUTIONS}/3", json={"name": "Новое"}),
        client.delete(f"{SOLUTIONS}/3"),
    ]

    assert [response.status_code for response in responses] == [401, 401, 401]
    for response in responses:
        assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


# --- Список -----------------------------------------------------------------


def test_list_forwards_to_the_platform_catalog(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=CATALOG)
    login(client)

    response = client.get(SOLUTIONS)

    assert response.status_code == 200, response.text
    assert response.json() == CATALOG
    request = main_api.requests[-1]
    assert request.method == "GET"
    assert request.url.path == PLATFORM_PATH
    # Кабинет доказывает основному API, что он кабинет, только этим заголовком.
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_list_keeps_hidden_rows_and_the_price_label(client: TestClient, main_api: MainApi) -> None:
    """Снятые с продажи строки кабинет не отфильтровывает: это делает только магазин."""
    main_api.handler = lambda request: httpx.Response(200, json=CATALOG)
    login(client)

    body = client.get(SOLUTIONS).json()

    assert [item["is_visible"] for item in body] == [True, False]
    # `price_label` приходит готовым: кабинет формулу цены не повторяет, а период
    # подписи — «разово»: своего срока у решения нет (#195).
    assert body[0]["price_label"] == "500 ₽ разово"
    assert "period" not in body[0]
    # `code` — машинное имя решения, в кабинете только показ.
    assert body[0]["code"] == "telegram_notifications"
    assert body[1]["description"] is None


def test_empty_catalog_is_an_empty_array(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=[])
    login(client)

    assert client.get(SOLUTIONS).json() == []


# --- Правка -----------------------------------------------------------------


def test_patch_forwards_only_the_sent_fields(client: TestClient, main_api: MainApi) -> None:
    """Тело правки уходит наверх как есть: непереданные поля не обнуляются."""
    main_api.handler = lambda request: httpx.Response(200, json=SOLUTION)
    login(client)

    response = client.patch(f"{SOLUTIONS}/3", json={"description": "Новое описание"})

    assert response.status_code == 200, response.text
    assert response.json() == SOLUTION
    request = main_api.requests[-1]
    assert request.method == "PATCH"
    assert request.url.path == f"{PLATFORM_PATH}/3"
    assert json.loads(request.content) == {"description": "Новое описание"}
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_patch_forwards_every_field_of_the_cabinet_form(
    client: TestClient, main_api: MainApi
) -> None:
    """Шесть полей формы уходят наверх целиком: кабинет их не переименовывает.

    Периода оплаты в форме нет (#195): у решения нет собственного срока, право
    действует по тарифу организации.
    """
    payload = {
        "name": "Журнал действий",
        "description": "Кто, когда и что изменил",
        "amount": "1500.00",
        "currency": "USD",
        "position": 0,
        "is_visible": False,
    }
    main_api.handler = lambda request: httpx.Response(200, json={**SOLUTION, **payload})
    login(client)

    response = client.patch(f"{SOLUTIONS}/3", json=payload)

    assert response.status_code == 200, response.text
    assert json.loads(main_api.requests[-1].content) == payload


def test_patch_forwards_the_period_to_be_rejected_upstairs(
    client: TestClient, main_api: MainApi
) -> None:
    """Присланный `period` не отсеивается кабинетом — на него отвечает основной API.

    Поле ушло из контракта (#195), и отказ приходит стандартным `422` `pydantic`
    (`extra_forbidden`) оттуда же, откуда и остальные тексты: второй копии правил
    в кабинете нет.
    """
    errors = [
        {
            "type": "extra_forbidden",
            "loc": ["body", "period"],
            "msg": "Extra inputs are not permitted",
            "input": "year",
        }
    ]
    main_api.handler = respond(errors, 422)
    login(client)

    response = client.patch(f"{SOLUTIONS}/3", json={"period": "year"})

    assert response.status_code == 422
    assert response.json() == {"detail": errors}
    assert json.loads(main_api.requests[-1].content) == {"period": "year"}


def test_patch_forwards_a_foreign_field_to_be_rejected_upstairs(
    client: TestClient, main_api: MainApi
) -> None:
    """`code` правке не подлежит, но отказ приходит от основного API, а не от кабинета.

    Своих правил проверки значений у кабинета нет: лишнее поле уходит наверх, и
    `422` основного API клиент получает дословно.
    """
    errors = [
        {
            "type": "extra_forbidden",
            "loc": ["body", "code"],
            "msg": "Extra inputs are not permitted",
            "input": "journal",
        }
    ]
    main_api.handler = respond(errors, 422)
    login(client)

    response = client.patch(f"{SOLUTIONS}/3", json={"code": "journal"})

    assert response.status_code == 422
    assert response.json() == {"detail": errors}
    assert json.loads(main_api.requests[-1].content) == {"code": "journal"}


@pytest.mark.parametrize(
    ("payload", "field", "message"),
    [
        # Дробный порядок: с полем `int | None` кабинет отвечал английским текстом
        # `pydantic` («Input should be a valid integer, got a number with a
        # fractional part») вместо русского текста контракта.
        ({"position": 1.5}, "position", "Порядок должен быть целым числом"),
        # Строка и `bool` приводились к числу и уходили наверх как `3` и `1`:
        # основной API ровно эти значения отвергает, а кабинет отвечал `200`.
        ({"position": "3"}, "position", "Порядок должен быть целым числом"),
        ({"position": True}, "position", "Порядок должен быть целым числом"),
        # `1` приводился к `true` (`bool` — подкласс `int`), `"да"` давала
        # английский текст вместо «Состояние должно быть true или false».
        ({"is_visible": 1}, "is_visible", "Состояние должно быть true или false"),
        ({"is_visible": "да"}, "is_visible", "Состояние должно быть true или false"),
        # Число вместо названия: текст «Название не может быть пустым» — тоже
        # русского контракта, а не `pydantic`.
        ({"name": 42}, "name", "Название не может быть пустым"),
    ],
)
def test_patch_does_not_validate_or_coerce_values(
    client: TestClient,
    main_api: MainApi,
    payload: dict[str, object],
    field: str,
    message: str,
) -> None:
    """Кабинет не проверяет и не приводит значения: отказ приходит от основного API.

    Это замечание Б1 ревью №1: с полями `str`/`int`/`bool` `pydantic` приводил
    присланное до отправки, и кабинет отвечал `200` или английским текстом там,
    где контракт обещает `422` с русским текстом. Договор кабинета — «тело уходит
    наверх как есть», поэтому проверяется и тело запроса, и дословный `detail`.
    """
    errors = [
        {
            "type": "value_error",
            "loc": ["body", field],
            "msg": f"Value error, {message}",
            "input": next(iter(payload.values())),
        }
    ]
    main_api.handler = respond(errors, 422)
    login(client)

    response = client.patch(f"{SOLUTIONS}/3", json=payload)

    assert response.status_code == 422, response.text
    assert response.json() == {"detail": errors}
    # Присланное ушло наверх без приведения: `1.5` не стал `1`, `"3"` — числом.
    assert json.loads(main_api.requests[-1].content) == payload


def test_patch_publishes_a_hidden_solution(client: TestClient, main_api: MainApi) -> None:
    """«Опубликовать» — это `PATCH {"is_visible": true}`, и тело не переписывается."""
    published = {**HIDDEN_SOLUTION, "is_visible": True}
    main_api.handler = lambda request: httpx.Response(200, json=published)
    login(client)

    response = client.patch(f"{SOLUTIONS}/4", json={"is_visible": True})

    assert response.status_code == 200, response.text
    assert response.json()["is_visible"] is True
    assert json.loads(main_api.requests[-1].content) == {"is_visible": True}


def test_patch_brings_the_recalculated_price_label(client: TestClient, main_api: MainApi) -> None:
    """`price_label` считает основной API: кабинет его не собирает."""
    repriced = {**SOLUTION, "amount": "1500.00", "currency": "USD", "price_label": "1 500 $"}
    main_api.handler = lambda request: httpx.Response(200, json=repriced)
    login(client)

    body = client.patch(f"{SOLUTIONS}/3", json={"amount": "1500.00", "currency": "USD"}).json()

    assert body["price_label"] == "1 500 $"
    assert body["amount"] == "1500.00"


# --- Снятие с продажи -------------------------------------------------------


def test_delete_answers_204_without_a_body(client: TestClient, main_api: MainApi) -> None:
    """`DELETE` основного API отвечает `204`: кабинет отдаёт его без тела."""
    main_api.handler = lambda request: httpx.Response(204)
    login(client)

    response = client.delete(f"{SOLUTIONS}/3")

    assert response.status_code == 204
    assert response.content == b""
    request = main_api.requests[-1]
    assert request.method == "DELETE"
    assert request.url.path == f"{PLATFORM_PATH}/3"
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_repeated_delete_is_idempotent(client: TestClient, main_api: MainApi) -> None:
    """Повторный `DELETE` — тот же `204`: основной API не различает состояния."""
    main_api.handler = lambda request: httpx.Response(204)
    login(client)

    assert client.delete(f"{SOLUTIONS}/3").status_code == 204
    assert client.delete(f"{SOLUTIONS}/3").status_code == 204


def test_other_success_codes_are_not_success(client: TestClient, main_api: MainApi) -> None:
    """Успехом считаются только `200` и `204`: `201` — расхождение контракта."""
    main_api.handler = lambda request: httpx.Response(201, json={"id": 9})
    login(client)

    response = client.get(SOLUTIONS)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


# --- Перевод отказов основного API ------------------------------------------


def test_not_found_detail_is_passed_through(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = respond("Решение не найдено", 404)
    login(client)

    response = client.patch(f"{SOLUTIONS}/3", json={"name": "Новое"})

    assert response.status_code == 404
    assert response.json() == {"detail": "Решение не найдено"}


def test_conflict_detail_is_passed_through(client: TestClient, main_api: MainApi) -> None:
    """Занятое имя — текст основного API, дословно: кабинет его не переписывает."""
    main_api.handler = respond("Решение с таким названием уже есть", 409)
    login(client)

    response = client.patch(f"{SOLUTIONS}/3", json={"name": "ЖУРНАЛ ДЕЙСТВИЙ"})

    assert response.status_code == 409
    assert response.json() == {"detail": "Решение с таким названием уже есть"}


def test_validation_errors_keep_the_list_of_errors(client: TestClient, main_api: MainApi) -> None:
    """`422` основного API — со списком ошибок FastAPI, и он не переписывается."""
    errors = [
        {
            "type": "value_error",
            "loc": ["body", "position"],
            "msg": "Value error, Порядок не может быть отрицательным",
            "input": -1,
        }
    ]
    main_api.handler = respond(errors, 422)
    login(client)

    response = client.patch(f"{SOLUTIONS}/3", json={"position": -1})

    assert response.status_code == 422
    assert response.json() == {"detail": errors}


def test_delete_of_an_unknown_solution_is_not_found(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = respond("Решение не найдено", 404)
    login(client)

    response = client.delete(f"{SOLUTIONS}/999999")

    assert response.status_code == 404
    assert response.json() == {"detail": "Решение не найдено"}


def test_rejected_token_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    """401 основного API — это 502, а не разлогин оператора."""
    main_api.handler = respond("Неверный сервисный токен", 401)
    login(client)

    response = client.get(SOLUTIONS)

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

    response = client.get(SOLUTIONS)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_network_failure_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети", request=request)

    main_api.handler = boom
    login(client)

    response = client.delete(f"{SOLUTIONS}/3")

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_timeout_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("слишком долго", request=request)

    main_api.handler = slow
    login(client)

    response = client.patch(f"{SOLUTIONS}/3", json={"name": "Новое"})

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


# --- Настройка кабинета -----------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", SOLUTIONS, None),
        ("patch", f"{SOLUTIONS}/3", {"name": "Новое"}),
        ("delete", f"{SOLUTIONS}/3", None),
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
