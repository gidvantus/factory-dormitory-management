"""Организации платформы: кабинет — тонкий прокси к основному API.

Данных кабинет не хранит: список, карточка и правка идут в основной API по
внутренней сети (`http://api:8000`) с сервисным токеном в заголовке
`X-Operator-Token`. Здесь только HTTP: сессия кабинета, запрос наверх и
перевод отказов.

Отказы не переписываются. Текст — часть контракта основного API, и второй его
экземпляр в кабинете разошёлся бы с оригиналом на первой же правке. Поэтому:

* `404`, `409`, `422` — тот же код и тот же `detail`, что у основного API;
* `401` от основного API — это `502`: кабинет не принял токен, и клиенту не
  надо об этом знать подробностей, а браузер не должен разлогиниваться;
* сеть, таймаут и `5xx` — `502 «Основной API недоступен»`;
* пустой `OPERATOR_SERVICE_TOKEN` — `503` без похода в сеть.
"""

from collections.abc import Iterator
from typing import Annotated, Any, NoReturn

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.config import get_settings
from app.schemas import (
    ErrorResponse,
    OrganizationDetails,
    OrganizationPage,
    UpdateOrganizationRequest,
)
from app.security import UNAUTHORIZED_DETAIL, CurrentOperator

router = APIRouter(prefix="/organizations", tags=["organizations"])

# Заголовок сервисного контура. Тот же, что ждёт основной API
# (`app/backend/app/security.py`): имя заголовка — часть контракта.
OPERATOR_TOKEN_HEADER = "X-Operator-Token"

# Тексты отказов самого кабинета. Отказы данных (404/409/422) сюда не входят:
# они приходят из основного API и передаются дословно.
OPERATOR_SERVICE_TOKEN_MISSING_DETAIL = "Кабинет не настроен: не задан OPERATOR_SERVICE_TOKEN"
MAIN_API_REJECTED_TOKEN_DETAIL = "Основной API не принял сервисный токен"
MAIN_API_UNAVAILABLE_DETAIL = "Основной API недоступен"

# Пути основного API. Собраны в одном месте: кабинет не должен знать о них
# ничего, кроме этих трёх строк.
MAIN_API_ORGANIZATIONS_PATH = "/api/platform/organizations"

# Коды, которые передаются клиенту как есть, вместе с `detail`.
PASS_THROUGH_STATUSES = frozenset(
    {
        status.HTTP_404_NOT_FOUND,
        status.HTTP_409_CONFLICT,
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    }
)

DEFAULT_LIMIT = 50
MAX_LIMIT = 100

# Единое описание отказов авторизации кабинета: без cookie сессии — 401.
UNAUTHORIZED_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": UNAUTHORIZED_DETAIL,
    },
}

# Отказы шлюза: они бывают у всех трёх ручек и означают разное.
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

LIST_RESPONSES: dict[int | str, dict[str, object]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "`limit` вне 1..100 или `offset` меньше нуля",
    },
}

DETAILS_RESPONSES: dict[int | str, dict[str, object]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Организация не найдена",
    },
}

UPDATE_RESPONSES: dict[int | str, dict[str, object]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Организация не найдена",
    },
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": "Организация с таким ИНН уже есть",
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Пустое название, ИНН не по формату или лишнее поле",
    },
}

PageLimit = Annotated[int, Query(ge=1, le=MAX_LIMIT)]
PageOffset = Annotated[int, Query(ge=0)]


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


def _service_token() -> str:
    """Секрет сервисного контура. Пустой — `503` до любого сетевого вызова."""
    token = get_settings().operator_service_token
    if not token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=OPERATOR_SERVICE_TOKEN_MISSING_DETAIL,
        )
    return token


def _error_detail(response: httpx.Response) -> Any:
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


def _forward_error(response: httpx.Response) -> NoReturn:
    """Перевести отказ основного API в отказ кабинета.

    401 значит, что не сошёлся секрет сервисного контура: это наша поломка, а не
    истёкшая сессия оператора, поэтому клиенту 502 и кабинет не разлогинивает.
    """
    if response.status_code in PASS_THROUGH_STATUSES:
        raise HTTPException(status_code=response.status_code, detail=_error_detail(response))
    if response.status_code == status.HTTP_401_UNAUTHORIZED:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=MAIN_API_REJECTED_TOKEN_DETAIL,
        )
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail=MAIN_API_UNAVAILABLE_DETAIL,
    )


def _call(
    client: httpx.Client,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json: dict[str, Any] | None = None,
) -> httpx.Response:
    """Один запрос наверх. Сеть и таймаут — `502 «Основной API недоступен»`."""
    token = _service_token()
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
        _forward_error(response)
    return response


@router.get(
    "",
    response_model=OrganizationPage,
    summary="Список организаций",
    responses=LIST_RESPONSES,
)
def list_organizations(
    _operator: CurrentOperator,
    client: MainApiClient,
    limit: PageLimit = DEFAULT_LIMIT,
    offset: PageOffset = 0,
) -> OrganizationPage:
    """Страница организаций из основного API: свежие сверху.

    Постраничная выдача — единственная возможность выбрать не всё сразу:
    поиска и фильтров по списку нет по постановке.
    """
    response = _call(
        client,
        "GET",
        MAIN_API_ORGANIZATIONS_PATH,
        params={"limit": limit, "offset": offset},
    )
    return OrganizationPage.model_validate(response.json())


@router.get(
    "/{organization_id}",
    response_model=OrganizationDetails,
    summary="Карточка организации",
    responses=DETAILS_RESPONSES,
)
def read_organization(
    organization_id: int,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> OrganizationDetails:
    """Организация с реквизитами и счётчиками. Неизвестный `id` — `404` дословно."""
    response = _call(client, "GET", f"{MAIN_API_ORGANIZATIONS_PATH}/{organization_id}")
    return OrganizationDetails.model_validate(response.json())


@router.patch(
    "/{organization_id}",
    response_model=OrganizationDetails,
    summary="Изменить данные организации",
    responses=UPDATE_RESPONSES,
)
def update_organization(
    organization_id: int,
    payload: UpdateOrganizationRequest,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> OrganizationDetails:
    """Передать правку в основной API и вернуть то, что он сохранил.

    Значения полей не проверяются здесь вовсе: правило ИНН и запрет пустого
    названия живут в основном API, а кабинет передаёт его `422` дословно.
    """
    response = _call(
        client,
        "PATCH",
        f"{MAIN_API_ORGANIZATIONS_PATH}/{organization_id}",
        json=payload.forwarded(),
    )
    return OrganizationDetails.model_validate(response.json())
