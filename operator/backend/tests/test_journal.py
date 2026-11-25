"""Журнал в кабинете оператора: прокси в `GET /api/platform/journal` основного API.

Сети нет: HTTP-клиент строится на `httpx.MockTransport` (см. `tests/conftest.py`).
Проверяется то, что кабинет отправляет наверх, и то, что возвращает вниз. Тексты
отказов основного API обязаны дойти дословно: кабинет их не переписывает.
"""

import httpx
from fastapi.testclient import TestClient

from app.main_api import (
    MAIN_API_REJECTED_TOKEN_DETAIL,
    MAIN_API_UNAVAILABLE_DETAIL,
    OPERATOR_SERVICE_TOKEN_MISSING_DETAIL,
    OPERATOR_TOKEN_HEADER,
)
from app.security import UNAUTHORIZED_DETAIL
from tests.conftest import SERVICE_TOKEN, MainApi, login, respond

JOURNAL = "/api/journal"
PLATFORM_PATH = "/api/platform/journal"

ENTRY = {
    "id": 11,
    "created_at": "2026-11-20T10:00:00Z",
    "organization_id": 3,
    "organization_name": "ООО Ромашка",
    "actor_id": 5,
    "actor_name": None,
    "method": "PATCH",
    "path": "/api/dormitories/{dormitory_id}",
    "action": "patch_dormitories",
    "action_title": "Изменил общежитие",
    "kind": "data",
    "status": 200,
    "duration_ms": 14,
    "ip": None,
    "user_agent": None,
    "request_id": None,
    "path_params": {"dormitory_id": "42"},
    "request_body": None,
    "changes": None,
}
PAGE = {"items": [ENTRY], "next_cursor": None, "total": 1}


def test_without_session_the_journal_is_unauthorized(client: TestClient) -> None:
    """Сессия кабинета обязательна - сервисный токен её не заменяет."""
    response = client.get(JOURNAL)

    assert response.status_code == 401
    assert response.json() == {"detail": UNAUTHORIZED_DETAIL}


def test_no_parameters_means_no_query_upstream(client: TestClient, main_api: MainApi) -> None:
    """Без параметров наверх уходит голый путь: период и вид решает основной API."""
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    response = client.get(JOURNAL)

    assert response.status_code == 200, response.text
    request = main_api.requests[-1]
    assert request.method == "GET"
    assert request.url.path == PLATFORM_PATH
    assert request.url.query == b""
    assert request.headers[OPERATOR_TOKEN_HEADER] == SERVICE_TOKEN


def test_only_passed_parameters_are_forwarded(client: TestClient, main_api: MainApi) -> None:
    """Переданные параметры уходят как есть, непереданные не появляются наверху."""
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    response = client.get(
        JOURNAL,
        params={"kind": "security", "date_from": "2026-11-01", "limit": 10},
    )

    assert response.status_code == 200, response.text
    params = main_api.requests[-1].url.params
    assert params["kind"] == "security"
    assert params["date_from"] == "2026-11-01"
    assert params["limit"] == "10"
    assert "date_to" not in params
    assert "cursor" not in params


def test_cursor_is_forwarded_opaquely(client: TestClient, main_api: MainApi) -> None:
    """Курсор кабинет не разбирает: строка уходит наверх как получена."""
    cursor = "2026-11-20T10:00:00Z|11"
    main_api.handler = lambda request: httpx.Response(200, json=PAGE)
    login(client)

    response = client.get(JOURNAL, params={"cursor": cursor})

    assert response.status_code == 200, response.text
    assert main_api.requests[-1].url.params["cursor"] == cursor


def test_platform_rows_and_names_come_back_unchanged(client: TestClient, main_api: MainApi) -> None:
    """Строка контура без организации (`organization_id = null`) доходит как есть."""
    platform_row = {
        **ENTRY,
        "id": 12,
        "organization_id": None,
        "organization_name": None,
        "action": "post_login",
        "action_title": "Вход",
        "kind": "security",
    }
    main_api.handler = lambda request: httpx.Response(
        200, json={"items": [ENTRY, platform_row], "next_cursor": "c|1", "total": 2}
    )
    login(client)

    response = client.get(JOURNAL)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["items"][1]["organization_id"] is None
    assert body["items"][1]["organization_name"] is None
    assert body["items"][0]["organization_name"] == "ООО Ромашка"
    assert body["next_cursor"] == "c|1"
    assert body["total"] == 2


def test_upstream_range_error_is_forwarded_verbatim(client: TestClient, main_api: MainApi) -> None:
    """422 по периоду: текст основного API дословно, без приставок и без точки."""
    detail = "Слишком длинный период: журнал отдаётся не больше чем за 90 дней"
    main_api.handler = respond(detail, 422)
    login(client)

    response = client.get(JOURNAL, params={"date_from": "2026-01-01", "date_to": "2026-11-01"})

    assert response.status_code == 422
    assert response.json() == {"detail": detail}


def test_rejected_token_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    """401 основного API - 502, а не разлогин оператора: сессия кабинета остаётся."""
    main_api.handler = respond("Неверный сервисный токен", 401)
    login(client)

    response = client.get(JOURNAL)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_REJECTED_TOKEN_DETAIL}
    assert client.get("/api/auth/me").status_code == 200


def test_server_error_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    """500 и 503 основного API - `502 Основной API недоступен`."""
    main_api.handler = lambda request: httpx.Response(500, json={"detail": "boom"})
    login(client)

    response = client.get(JOURNAL)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_network_failure_is_a_bad_gateway(client: TestClient, main_api: MainApi) -> None:
    """Сети нет - 502 с текстом недоступности, без трассировки."""

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("нет сети", request=request)

    main_api.handler = boom
    login(client)

    response = client.get(JOURNAL)

    assert response.status_code == 502
    assert response.json() == {"detail": MAIN_API_UNAVAILABLE_DETAIL}


def test_empty_token_answers_503_without_touching_the_network(
    client: TestClient, empty_token: MainApi
) -> None:
    """Пустой секрет - настройка кабинета: 503 и ни одного запроса наверх."""
    login(client)

    response = client.get(JOURNAL)

    assert response.status_code == 503
    assert response.json() == {"detail": OPERATOR_SERVICE_TOKEN_MISSING_DETAIL}
    assert empty_token.requests == []
