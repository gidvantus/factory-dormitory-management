"""Модуль DaData: разбор ответа и разделение «не найдено» / «недоступно».

Сети в тестах нет: HTTP-клиент собирается на `httpx.MockTransport`, поэтому
проверяется ровно разбор ответа и обработка сбоев. Ключ и адрес сервиса
передаются в модуль явно, а не берутся из окружения машины.
"""

from collections.abc import Callable

import httpx
import pytest

from app import dadata
from app.config import Settings

# Тестовый токен: 40 hex-символов, как настоящий, но заведомо нерабочий.
TOKEN = "0123456789abcdef0123456789abcdef01234567"
INN = "7707083893"
DADATA_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party"

# Ответ DaData по ИНН ПАО Сбербанк — форма, на которой проверяется разбор.
SBERBANK_BODY: dict[str, object] = {
    "suggestions": [
        {
            "value": "ПАО СБЕРБАНК",
            "unrestricted_value": "117312, г Москва, ул Вавилова, д 19",
            "data": {
                "inn": INN,
                "ogrn": "1027700132195",
                "kpp": "773601001",
                "name": {"short_with_opf": "ПАО СБЕРБАНК"},
                "address": {"unrestricted_value": "117312, г Москва, ул Вавилова, д 19"},
            },
        }
    ]
}


def make_settings(*, api_key: str = TOKEN, url: str = DADATA_URL) -> Settings:
    """Настройки с явными значениями: окружение машины в тестах не участвует."""
    return Settings(
        database_url="sqlite+pysqlite:///:memory:",
        jwt_secret="unit-test-secret-value-0123456789",
        dadata_api_key=api_key,
        dadata_url=url,
        dadata_timeout_seconds=5.0,
    )


def client_with(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def json_response(body: object, status_code: int = 200) -> httpx.Response:
    return httpx.Response(status_code, json=body)


def test_parses_requisites_and_sends_the_token_as_is() -> None:
    """Токен уходит в заголовке как есть: без имени переменной из личного кабинета."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return json_response(SBERBANK_BODY)

    with client_with(handler) as client:
        found = dadata.lookup_organization(INN, client=client, settings=make_settings())

    assert found == dadata.OrganizationRequisites(
        name="ПАО СБЕРБАНК",
        kpp="773601001",
        ogrn="1027700132195",
        address="117312, г Москва, ул Вавилова, д 19",
    )
    assert len(seen) == 1
    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == DADATA_URL
    assert request.headers["Authorization"] == f"Token {TOKEN}"
    assert request.headers["Content-Type"] == "application/json"
    assert request.headers["Accept"] == "application/json"
    assert request.content == b'{"query":"7707083893","count":1}'


def test_individual_entrepreneur_has_no_kpp() -> None:
    """У ИП приходит `kpp: null` — КПП остаётся пустым, а не «0000» и не «-»."""
    body = {
        "suggestions": [
            {
                "value": "ИП Иванов Иван Иванович",
                "data": {
                    "inn": "500100732259",
                    "ogrn": "304500116000157",
                    "kpp": None,
                    "name": {"short_with_opf": "ИП Иванов И.И."},
                    "address": {"unrestricted_value": "140000, Московская обл, г Люберцы"},
                },
            }
        ]
    }

    with client_with(lambda _request: json_response(body)) as client:
        found = dadata.lookup_organization("500100732259", client=client, settings=make_settings())

    assert found is not None
    assert found.name == "ИП Иванов И.И."
    assert found.kpp is None
    assert found.ogrn == "304500116000157"
    assert found.address == "140000, Московская обл, г Люберцы"


def test_empty_suggestions_mean_not_found() -> None:
    """Незнакомый ИНН — это HTTP 200 с пустым списком, а не ошибка сети."""
    with client_with(lambda _request: json_response({"suggestions": []})) as client:
        found = dadata.lookup_organization("7707083890", client=client, settings=make_settings())

    assert found is None


def test_empty_key_is_unavailable_and_makes_no_request() -> None:
    """Пустой ключ не ломает приложение: поиск сразу отвечает «недоступно»."""
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return json_response(SBERBANK_BODY)

    with client_with(handler) as client, pytest.raises(dadata.DadataUnavailable):
        dadata.lookup_organization(INN, client=client, settings=make_settings(api_key="   "))

    assert calls == 0


@pytest.mark.parametrize("status_code", [400, 403, 500, 502])
def test_error_status_is_unavailable(status_code: int) -> None:
    """400 (битый токен) и прочие ошибки — это наша поломка, а не ошибка ввода."""
    with (
        client_with(
            lambda _request: json_response({"detail": "error"}, status_code=status_code)
        ) as client,
        pytest.raises(dadata.DadataUnavailable),
    ):
        dadata.lookup_organization(INN, client=client, settings=make_settings())


def test_network_error_is_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("нет ответа", request=request)

    with client_with(handler) as client, pytest.raises(dadata.DadataUnavailable):
        dadata.lookup_organization(INN, client=client, settings=make_settings())


def test_body_that_is_not_json_is_unavailable() -> None:
    response = httpx.Response(200, text="<html>не JSON</html>")

    with client_with(lambda _request: response) as client, pytest.raises(dadata.DadataUnavailable):
        dadata.lookup_organization(INN, client=client, settings=make_settings())


def test_long_values_are_cut_to_the_column_limits() -> None:
    """Значение из справочника длиннее колонки не должно ронять сохранение."""
    body = {
        "suggestions": [
            {
                "value": "ООО Тест",
                "data": {
                    "inn": INN,
                    "ogrn": "1" * 40,
                    "kpp": "2" * 40,
                    "name": {"short_with_opf": "О" * 400},
                    "address": {"unrestricted_value": "А" * 900},
                },
            }
        ]
    }

    with client_with(lambda _request: json_response(body)) as client:
        found = dadata.lookup_organization(INN, client=client, settings=make_settings())

    assert found is not None
    assert found.name is not None and len(found.name) == dadata.MAX_NAME_LENGTH
    assert found.kpp is not None and len(found.kpp) == dadata.MAX_KPP_LENGTH
    assert found.ogrn is not None and len(found.ogrn) == dadata.MAX_OGRN_LENGTH
    assert found.address is not None and len(found.address) == dadata.MAX_ADDRESS_LENGTH


def test_blank_fields_become_none() -> None:
    """Пробелы и пустые строки в ответе — это пустое поле, а не «  »."""
    body = {
        "suggestions": [
            {
                "data": {
                    "ogrn": "   ",
                    "kpp": "",
                    "name": {"short_with_opf": "  ПАО СБЕРБАНК  "},
                    "address": {},
                }
            }
        ]
    }

    with client_with(lambda _request: json_response(body)) as client:
        found = dadata.lookup_organization(INN, client=client, settings=make_settings())

    assert found is not None
    assert found.name == "ПАО СБЕРБАНК"
    assert found.kpp is None
    assert found.ogrn is None
    assert found.address is None
