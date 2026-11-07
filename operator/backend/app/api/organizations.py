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
    SubscriptionState,
    UpdateOrganizationRequest,
    UpdateSubscriptionRequest,
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

# Отказы раздела тарифа и расширений (#189). Тексты не переписываются: `404`
# приходит из основного API дословно («Организация не найдена», «Расширение не
# найдено»), `409` — «Тариф не назначен», а `422` — его валидатор формата даты.
SUBSCRIPTION_RESPONSES: dict[int | str, dict[str, object]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Организация не найдена",
    },
}

# Обе write-ручки подписки отказывают одинаково, когда менять нечего: `409`
# приходит из основного API дословно, как и остальные отказы данных.
WRITE_SUBSCRIPTION_RESPONSES: dict[int | str, dict[str, object]] = {
    **SUBSCRIPTION_RESPONSES,
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": "Тариф не назначен — отказ основного API",
    },
}

UPDATE_SUBSCRIPTION_RESPONSES: dict[int | str, dict[str, object]] = {
    **WRITE_SUBSCRIPTION_RESPONSES,
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Срок не в формате ГГГГ-ММ-ДД, лишнее поле или тело не по схеме — "
        "отказ основного API",
    },
}

DEACTIVATE_SOLUTION_RESPONSES: dict[int | str, dict[str, object]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Организация не найдена; Расширение не найдено",
    },
}


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


@router.get(
    "/{organization_id}/subscription",
    response_model=SubscriptionState,
    summary="Тариф и расширения организации",
    responses=SUBSCRIPTION_RESPONSES,
)
def read_subscription(
    organization_id: int,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> SubscriptionState:
    """Тариф, оплаченный вперёд слот и все права организации из основного API.

    Читается запись, а не «что действует сейчас»: истёкший текущий слот виден
    так же, как он лежит в базе. Срок, остаток дней и признаки «действует»
    приходят посчитанными — кабинет их не выводит. Неизвестный `id` — `404`
    дословно.
    """
    response = call(client, "GET", f"{MAIN_API_ORGANIZATIONS_PATH}/{organization_id}/subscription")
    return SubscriptionState.model_validate(response.json())


@router.patch(
    "/{organization_id}/subscription",
    response_model=SubscriptionState,
    summary="Изменить срок действия тарифа организации",
    responses=UPDATE_SUBSCRIPTION_RESPONSES,
)
def update_subscription(
    organization_id: int,
    payload: UpdateSubscriptionRequest,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> SubscriptionState:
    """Передать новый срок в основной API и вернуть состояние из ответа.

    Значение не проверяется и не приводится здесь вовсе: формат даты проверяет
    основной API, и его `422` с русским текстом уходит клиенту дословно. Слот без
    тарифа основной API отвергает `409 «Тариф не назначен»` — этот код тоже
    проходит насквозь (`app/main_api.py`). Ответ — тот же объект состояния, что у
    чтения, поэтому фронтенд показывает дату из него, а не из того, что ввели в
    поле.
    """
    response = call(
        client,
        "PATCH",
        f"{MAIN_API_ORGANIZATIONS_PATH}/{organization_id}/subscription",
        json=payload.forwarded(),
    )
    return SubscriptionState.model_validate(response.json())


@router.post(
    "/{organization_id}/subscription/deactivate",
    response_model=SubscriptionState,
    summary="Снять активность тарифа организации",
    responses=WRITE_SUBSCRIPTION_RESPONSES,
)
def deactivate_subscription(
    organization_id: int,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> SubscriptionState:
    """Снять активность текущего тарифа: тела нет, ответ — новое состояние.

    `204` в контуре не появляется: команда отвечает тем же объектом состояния,
    что и чтение, и фронтенд после нажатия показывает ответ, ничего не
    перезапрашивая. Повторный вызов — тоже `200`. Слот без тарифа — `409 «Тариф не
    назначен»` из основного API, дословно.
    """
    response = call(
        client,
        "POST",
        f"{MAIN_API_ORGANIZATIONS_PATH}/{organization_id}/subscription/deactivate",
    )
    return SubscriptionState.model_validate(response.json())


@router.post(
    "/{organization_id}/solutions/{code}/deactivate",
    response_model=SubscriptionState,
    summary="Снять активность расширения организации",
    responses=DEACTIVATE_SOLUTION_RESPONSES,
)
def deactivate_solution(
    organization_id: int,
    code: str,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> SubscriptionState:
    """Снять активность права на решение: тела нет, ответ — новое состояние.

    `code` — машинный код решения из ответа чтения; он же уходит в путь основного
    API. Неизвестный код — `404 «Расширение не найдено»` дословно; **повторное
    снятие — тоже `404`**: после #195 отзыв удаляет строку права, и снимать
    «уже снятое» нечего. Кабинет различает «снял только что» и «снимать нечего»
    по коду ответа.
    """
    response = call(
        client,
        "POST",
        f"{MAIN_API_ORGANIZATIONS_PATH}/{organization_id}/solutions/{code}/deactivate",
    )
    return SubscriptionState.model_validate(response.json())
