"""Организации платформы: кабинет — тонкий прокси к основному API.

Данных кабинет не хранит: список, карточка и правка идут в основной API по
внутренней сети (`http://api:8000`) с сервисным токеном в заголовке
`X-Operator-Token`. Здесь только HTTP: сессия кабинета, запрос наверх и
перевод отказов.

Отказы не переписываются. Клиент, секрет контура и правила перевода отказов
живут в `app/main_api.py`: они общие с разделом пользователей (`api/users.py`),
и вторая их копия разошлась бы с первой на первой же правке.
"""

from typing import Annotated

from fastapi import APIRouter, Query, status

from app.main_api import (
    GATEWAY_RESPONSES,
    UNAUTHORIZED_RESPONSES,
    MainApiClient,
    call,
)
from app.schemas import (
    ErrorResponse,
    OrganizationDetails,
    OrganizationPage,
    UpdateOrganizationRequest,
)
from app.security import CurrentOperator

router = APIRouter(prefix="/organizations", tags=["organizations"])

# Путь основного API. Собран в одном месте: кабинет не должен знать о нём
# ничего, кроме этой строки.
MAIN_API_ORGANIZATIONS_PATH = "/api/platform/organizations"

DEFAULT_LIMIT = 50
MAX_LIMIT = 100

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
    response = call(
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
    response = call(client, "GET", f"{MAIN_API_ORGANIZATIONS_PATH}/{organization_id}")
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
    response = call(
        client,
        "PATCH",
        f"{MAIN_API_ORGANIZATIONS_PATH}/{organization_id}",
        json=payload.forwarded(),
    )
    return OrganizationDetails.model_validate(response.json())
