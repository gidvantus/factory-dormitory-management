"""Пользователи платформы: кабинет — тонкий прокси к основному API.

Данных кабинет не хранит: список, карточка и правка ФИО идут в основной API по
внутренней сети с сервисным токеном в заголовке `X-Operator-Token`. Здесь только
HTTP: сессия кабинета, запрос наверх и перевод отказов.

Клиент, секрет контура и правила перевода отказов — общие с разделом
организаций (`app/main_api.py`). Тексты отказов основного API проходят насквозь:
«Пользователь не найден» и «ФИО не может быть пустым» клиент получает дословно.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Query, status

from app.main_api import (
    GATEWAY_RESPONSES,
    UNAUTHORIZED_RESPONSES,
    MainApiClient,
    call,
)
from app.schemas import (
    ErrorResponse,
    PlatformUser,
    PlatformUserPage,
    UpdatePlatformUserRequest,
)
from app.security import CurrentOperator

router = APIRouter(prefix="/users", tags=["users"])

# Путь основного API. Собран в одном месте: кабинет не должен знать о нём
# ничего, кроме этой строки.
MAIN_API_USERS_PATH = "/api/platform/users"

DEFAULT_LIMIT = 50
MAX_LIMIT = 100
MAX_SEARCH_LENGTH = 100

PageLimit = Annotated[int, Query(ge=1, le=MAX_LIMIT)]
PageOffset = Annotated[int, Query(ge=0)]
SearchQuery = Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH)]

LIST_RESPONSES: dict[int | str, dict[str, object]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "`limit` вне 1..100, `offset` меньше нуля или `search` длиннее 100 символов",
    },
}

DETAILS_RESPONSES: dict[int | str, dict[str, object]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Пользователь не найден",
    },
}

UPDATE_RESPONSES: dict[int | str, dict[str, object]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Пользователь не найден",
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "ФИО не может быть пустым или в теле есть лишнее поле",
    },
}


@router.get(
    "",
    response_model=PlatformUserPage,
    summary="Список пользователей",
    responses=LIST_RESPONSES,
)
def list_users(
    _operator: CurrentOperator,
    client: MainApiClient,
    limit: PageLimit = DEFAULT_LIMIT,
    offset: PageOffset = 0,
    search: SearchQuery = None,
) -> PlatformUserPage:
    """Страница реестра учётных записей из основного API: свежие сверху.

    `search` уходит наверх, только если клиент его прислал: параметр
    необязательный, а пустую строку разбирает уже основной API — своих правил
    поиска у кабинета нет.
    """
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if search is not None:
        params["search"] = search
    response = call(client, "GET", MAIN_API_USERS_PATH, params=params)
    return PlatformUserPage.model_validate(response.json())


@router.get(
    "/{user_id}",
    response_model=PlatformUser,
    summary="Карточка пользователя",
    responses=DETAILS_RESPONSES,
)
def read_user(
    user_id: int,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> PlatformUser:
    """Одна учётная запись. Неизвестный `id` — `404` с текстом основного API."""
    response = call(client, "GET", f"{MAIN_API_USERS_PATH}/{user_id}")
    return PlatformUser.model_validate(response.json())


@router.patch(
    "/{user_id}",
    response_model=PlatformUser,
    summary="Изменить ФИО пользователя",
    responses=UPDATE_RESPONSES,
)
def update_user(
    user_id: int,
    payload: UpdatePlatformUserRequest,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> PlatformUser:
    """Передать правку ФИО в основной API и вернуть то, что он сохранил.

    Значение не проверяется здесь: пустое ФИО и лишнее поле отсекает основной
    API, и его `422` уходит клиенту дословно.
    """
    response = call(
        client,
        "PATCH",
        f"{MAIN_API_USERS_PATH}/{user_id}",
        json=payload.forwarded(),
    )
    return PlatformUser.model_validate(response.json())
