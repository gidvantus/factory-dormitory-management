"""Общий слой кабинета оператора: клиент основного API и перевод отказов.

Кабинет данных не хранит: и организации, и пользователи читаются и правятся в
основном API по внутренней сети (`http://api:8000`) с сервисным токеном в
заголовке `X-Operator-Token`. Здесь только HTTP: адрес, клиент на запрос,
секрет контура и правила перевода отказов.

Слой один на оба роутера (`api/organizations.py`, `api/users.py`) намеренно:
вторая копия клиента и текстов отказов разошлась бы с первой на первой же
правке, и кабинет начал бы отвечать по-разному на одинаковые поломки.

Отказы не переписываются. Текст — часть контракта основного API, и второй его
экземпляр в кабинете тоже разошёлся бы с оригиналом. Поэтому:

* `404`, `409`, `422` — тот же код и тот же `detail`, что у основного API;
* `401` от основного API — это `502`: кабинет не принял токен, и браузер не
  должен из-за этого разлогиниваться;
* сеть, таймаут и `5xx` — `502 «Основной API недоступен»`;
* пустой `OPERATOR_SERVICE_TOKEN` — `503` без похода в сеть.
"""

from collections.abc import Iterator
from typing import Annotated, Any, NoReturn

import httpx
from fastapi import Depends, HTTPException, status

from app.config import get_settings
from app.schemas import ErrorResponse

# Заголовок сервисного контура. Тот же, что ждёт основной API
# (`app/backend/app/security.py`): имя заголовка — часть контракта.
OPERATOR_TOKEN_HEADER = "X-Operator-Token"

# Тексты отказов самого кабинета. Отказы данных (404/409/422) сюда не входят:
# они приходят из основного API и передаются дословно.
OPERATOR_SERVICE_TOKEN_MISSING_DETAIL = "Кабинет не настроен: не задан OPERATOR_SERVICE_TOKEN"
MAIN_API_REJECTED_TOKEN_DETAIL = "Основной API не принял сервисный токен"
MAIN_API_UNAVAILABLE_DETAIL = "Основной API недоступен"

# Коды, которые передаются клиенту как есть, вместе с `detail`.
PASS_THROUGH_STATUSES = frozenset(
    {
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    }
)

# Единое описание отказов авторизации кабинета: без cookie сессии — 401.
UNAUTHORIZED_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": "Требуется авторизация",
    },
}

# Отказы шлюза: они бывают у всех ручек и означают разное.
GATEWAY_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_502_BAD_GATEWAY: {
        "model": ErrorResponse,
        "description": f"{MAIN_API_REJECTED_TOKEN_DETAIL} или {MAIN_API_UNAVAILABLE_DETAIL}",
    },
    status.HTTP_503_SERVICE_UNAVAILABLE: {
        "model": ErrorResponse,
        "description": OPERATOR_SERVICE_TOKEN_MISSING_DETAIL,
    },
}


def main_api_client() -> Iterator[httpx.Client]:
    """HTTP-клиент основного API: создаётся на запрос, а не на импорт модуля.

    Глобальный клиент держал бы соединения между тестами и не давал бы подменить
    транспорт: тесты кабинета герметичны и в сеть не ходят. Адрес и таймаут из
    настроек, а не из кода: стенд задаёт их через `.env`.
    """
    settings = get_settings()
    with httpx.Client(
        base_url=settings.main_api_base_url,
        timeout=settings.main_api_timeout_seconds,
    ) as client:
        yield client


MainApiClient = Annotated[httpx.Client, Depends(main_api_client)]


def service_token() -> str:
    """Секрет сервисного контура. Пустой — `503` до любого сетевого вызова."""
    token = get_settings().operator_service_token
    if not token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=OPERATOR_SERVICE_TOKEN_MISSING_DETAIL,
        )
    return token


def error_detail(response: httpx.Response) -> Any:
    """`detail` из тела отказа основного API — без переписывания.

    У `422` в `detail` лежит список ошибок валидации FastAPI, у остальных —
    строка. Клиенту уходит то же самое, поэтому переводить его в строку нельзя.
    """
    try:
        body = response.json()
    except ValueError:
        return None
    if isinstance(body, dict):
        return body.get("detail")
    return None


def forward_error(response: httpx.Response) -> NoReturn:
    """Перевести отказ основного API в отказ кабинета.

    401 значит, что не сошёлся секрет сервисного контура: это наша поломка, а не
    истёкшая сессия оператора, поэтому клиенту 502 и кабинет не разлогинивает.
    """
    if response.status_code in PASS_THROUGH_STATUSES:
        raise HTTPException(status_code=response.status_code, detail=error_detail(response))
    if response.status_code == status.HTTP_401_UNAUTHORIZED:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=MAIN_API_REJECTED_TOKEN_DETAIL,
        )
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=MAIN_API_UNAVAILABLE_DETAIL,
    )


def call(
    client: httpx.Client,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json: dict[str, Any] | None = None,
) -> httpx.Response:
    """Один запрос наверх. Сеть и таймаут — `502 «Основной API недоступен»`."""
    token = service_token()
    try:
        response = client.request(
            method,
            path,
            params=params,
            json=json,
            headers={OPERATOR_TOKEN_HEADER: token},
        )
    except httpx.HTTPError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=MAIN_API_UNAVAILABLE_DETAIL,
        ) from None
    if response.status_code != status.HTTP_200_OK:
        forward_error(response)
    return response
