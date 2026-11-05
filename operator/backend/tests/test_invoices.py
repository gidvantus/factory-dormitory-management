"""Счета в кабинете оператора: прокси в основной API и перевод отказов.

Сети нет: HTTP-клиент строится на `httpx.MockTransport` (см. `tests/conftest.py`),
поэтому проверяется ровно то, что кабинет отправляет наверх и что возвращает
вниз. Тексты отказов данных приходят из основного API и обязаны дойти дословно:
кабинет их не собирает и не переписывает.

Две ручки отдают файл, а не JSON: их тело проверяется побайтово, а тип и имя
файла — по заголовкам ответа основного API. `.json()` на них вызывать нельзя,
и это тоже часть контракта.
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
INVOICES = f"{API}/invoices"
PLATFORM_PATH = "/api/platform/invoices"

INVOICE = {
    "id": 7,
    "number": "СЧ-2026-7",
    "status": "new",
    "status_label": "Новый",
    "item_kind": "tariff",
    # У тарифа и решения количество неприменимо — `null`, а не «один» (#168).
    "quantity": None,
    "amount": "10000.00",
    "currency": "RUB",
    "amount_label": "10 000,00 ₽ в месяц",
    "tariff_name": "Старт",
    "tariff_period": "month",
    "buyer_name": "ООО Ромашка",
    "buyer_inn": "7701234567",
    "buyer_kpp": "770101001",
    "buyer_ogrn": "1027700132195",
    "buyer_address": "г. Москва, ул. Тверская, д. 1",
    "has_act": False,
    "can_manage": True,
    "paid_at": None,
    "created_at": "2026-11-02T10:00:00Z",
    "organization_id": 3,
    "organization_name": "ООО Ромашка",
}
PAGE = {"items": [INVOICE], "total": 12}

PAID_INVOICE = {**INVOICE, "status": "paid", "status_label": "Оплачен", "has_act": True}

# Печатная форма: содержимое — не JSON, и кабинет обязан отдать его как есть.
PDF_BYTES = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"
PDF_DISPOSITION = (
    "attachment; filename=\"invoice-2026-7.pdf\"; filename*=UTF-8''invoice-%D0%A1%D0%A7-2026-7.pdf"
)


# --- Сессия кабинета --------------------------------------------------------


def test_without_session_every_route_is_unauthorized(client: TestClient) -> None:
    """Сессия кабинета обязательна — сервисный токен её не заменяет."""
    responses = [
        client.get(INVOICES),
        client.patch(f"{INVOICES}/7", json={"status": "paid"}),
        client.get(f"{INVOICES}/7/file"),
        client.get(f"{INVOICES}/7/act-file"),
    ]

    assert [response.status_code for response in responses] == [401, 401, 401, 401]
    for response in responses:
        assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


# --- Список -----------------------------------------------------------------


def test_list_forwards_the_page_and_the_filters(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    response = client.get(
        INVOICES,
        params={"limit": 10, "offset": 20, "status": "new", "search": "ромашка"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == PAGE
    request = main_api.requests[-1]
    assert request.method == "GET"
    assert request.url.path == PLATFORM_PATH
    assert request.url.params["limit"] == "10"
    assert request.url.params["offset"] == "20"
    assert request.url.params["status"] == "new"
    assert request.url.params["search"] == "ромашка"
    # Кабинет доказывает основному API, что он кабинет, только этим заголовком.
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_list_without_filters_does_not_send_them(client: TestClient, main_api: MainApi) -> None:
    """Фильтры необязательные: без них запрос уходит только со страницей."""
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    response = client.get(INVOICES)

    assert response.status_code == 200, response.text
    params = main_api.requests[-1].url.params
    assert params["limit"] == "50"
    assert params["offset"] == "0"
    assert "status" not in params
    assert "search" not in params


def test_list_page_size_and_search_bounds_are_validated(
    client: TestClient, main_api: MainApi
) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    assert client.get(INVOICES, params={"limit": 0}).status_code == 422
    assert client.get(INVOICES, params={"limit": 101}).status_code == 422
    assert client.get(INVOICES, params={"offset": -1}).status_code == 422
    assert client.get(INVOICES, params={"search": "я" * 101}).status_code == 422


def test_seats_invoice_keeps_its_kind_and_quantity(
    client: TestClient, main_api: MainApi
) -> None:
    """Счёт за места (#168): вид `seats` и количество доезжают до реестра оператора.

    `PlatformInvoice` кабинета — ручная копия модели основного API, а pydantic
    лишние для модели поля молча отбрасывает: без `quantity` в модели один
    докупленный сотрудник и сто выглядели бы в реестре одинаково.
    """
    seats_invoice = {
        **INVOICE,
        "item_kind": "seats",
        "quantity": 3,
        "amount": "2700.00",
        "tariff_name": "Дополнительные сотрудники",
        "tariff_period": "once",
    }
    main_api.handler = lambda request: httpx.Response(
        200, json={"items": [seats_invoice], "total": 1}
    )
    login(client)

    response = client.get(INVOICES)

    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    assert item["item_kind"] == "seats"
    assert item["quantity"] == 3
    assert item["amount"] == "2700.00"
    assert item["tariff_name"] == "Дополнительные сотрудники"
    assert item["tariff_period"] == "once"


# --- Оплата и отмена --------------------------------------------------------


def test_patch_forwards_only_the_status(client: TestClient, main_api: MainApi) -> None:
    """Тело смены статуса — единственное поле: оно уходит наверх как есть."""
    main_api.handler = lambda request: httpx.Response(200, json=PAID_INVOICE)
    login(client)

    response = client.patch(f"{INVOICES}/7", json={"status": "paid"})

    assert response.status_code == 200, response.text
    assert response.json() == PAID_INVOICE
    request = main_api.requests[-1]
    assert request.method == "PATCH"
    assert request.url.path == f"{PLATFORM_PATH}/7"
    assert json.loads(request.content) == {"status": "paid"}
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_patch_brings_the_status_label_from_the_main_api(
    client: TestClient, main_api: MainApi
) -> None:
    """`status_label` — от сервера: кабинет его не пересобирает."""
    main_api.handler = lambda request: httpx.Response(200, json=PAID_INVOICE)
    login(client)

    body = client.patch(f"{INVOICES}/7", json={"status": "paid"}).json()

    assert body["status_label"] == "Оплачен"
    assert body["has_act"] is True
    assert body["organization_name"] == "ООО Ромашка"


# --- Перевод отказов основного API ------------------------------------------


def test_not_found_detail_is_passed_through(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = respond("Счёт не найден", 404)
    login(client)

    response = client.patch(f"{INVOICES}/7", json={"status": "paid"})

    assert response.status_code == 404
    assert response.json() == {"detail": "Счёт не найден"}


def test_conflict_detail_is_passed_through(client: TestClient, main_api: MainApi) -> None:
    """Повторная оплата: текст `409` — из основного API, дословно."""
    main_api.handler = respond("Так нельзя изменить статус счёта", 409)
    login(client)

    response = client.patch(f"{INVOICES}/7", json={"status": "paid"})

    assert response.status_code == 409
    assert response.json() == {"detail": "Так нельзя изменить статус счёта"}


def test_act_not_found_detail_is_passed_through(client: TestClient, main_api: MainApi) -> None:
    """Акт до оплаты — `404` с текстом основного API, своего кабинет не заводит."""
    main_api.handler = respond("Акт по счёту ещё не сформирован", 404)
    login(client)

    response = client.get(f"{INVOICES}/7/act-file")

    assert response.status_code == 404
    assert response.json() == {"detail": "Акт по счёту ещё не сформирован"}
    assert main_api.requests[-1].url.path == f"{PLATFORM_PATH}/7/act-file"


def test_validation_errors_keep_the_list_of_errors(client: TestClient, main_api: MainApi) -> None:
    """`422` основного API — со списком ошибок FastAPI, и он не переписывается."""
    errors = [
        {
            "type": "literal_error",
            "loc": ["body", "status"],
            "msg": "Input should be 'paid', 'closed' or 'cancelled'",
            "input": "new",
        }
    ]
    main_api.handler = respond(errors, 422)
    login(client)

    response = client.patch(f"{INVOICES}/7", json={"status": "new"})

    assert response.status_code == 422
    assert response.json() == {"detail": errors}


def test_rejected_token_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    """401 основного API — это 502, а не разлогин оператора."""
    main_api.handler = respond("Неверный сервисный токен", 401)
    login(client)

    response = client.get(INVOICES)

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

    response = client.get(INVOICES)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_network_failure_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети", request=request)

    main_api.handler = boom
    login(client)

    response = client.get(f"{INVOICES}/7/file")

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_timeout_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("слишком долго", request=request)

    main_api.handler = slow
    login(client)

    response = client.patch(f"{INVOICES}/7", json={"status": "cancelled"})

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


# --- Печатные формы ---------------------------------------------------------


def test_invoice_file_is_proxied_byte_for_byte(client: TestClient, main_api: MainApi) -> None:
    """Файл вниз отдаётся байтами: тело не разбирается и не пересобирается."""
    main_api.handler = lambda request: httpx.Response(
        200,
        content=PDF_BYTES,
        headers={
            "Content-Type": "application/pdf",
            "Content-Disposition": PDF_DISPOSITION,
        },
    )
    login(client)

    response = client.get(f"{INVOICES}/7/file")

    assert response.status_code == 200, response.text
    assert response.content == PDF_BYTES
    assert response.headers["content-type"] == "application/pdf"
    # Имя файла приходит из основного API: кабинет его не переписывает.
    assert response.headers["content-disposition"] == PDF_DISPOSITION
    request = main_api.requests[-1]
    assert request.method == "GET"
    assert request.url.path == f"{PLATFORM_PATH}/7/file"
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_act_file_is_proxied_byte_for_byte(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(
        200,
        content=PDF_BYTES,
        headers={
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="act-2026-7.pdf"',
        },
    )
    login(client)

    response = client.get(f"{INVOICES}/7/act-file")

    assert response.status_code == 200, response.text
    assert response.content == PDF_BYTES
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == 'attachment; filename="act-2026-7.pdf"'
    assert main_api.requests[-1].url.path == f"{PLATFORM_PATH}/7/act-file"


# --- Настройка кабинета -----------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", INVOICES, None),
        ("patch", f"{INVOICES}/7", {"status": "paid"}),
        ("get", f"{INVOICES}/7/file", None),
        ("get", f"{INVOICES}/7/act-file", None),
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
