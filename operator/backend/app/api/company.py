"""Реквизиты поставщика: кабинет — тонкий прокси к основному API.

Данных кабинет не хранит: и чтение, и правка идут в основной API по внутренней
сети с сервисным токеном в заголовке `X-Operator-Token`. Здесь только HTTP:
сессия кабинета, запрос наверх и перевод отказов.

Клиент, секрет контура и правила перевода отказов — общие с разделами
организаций, пользователей, счетов и тарифов (`app/main_api.py`). Тексты отказов
основного API проходят насквозь: сообщения валидатора (`422`) клиент получает
дословно, а приставку `Value error, ` снимает фронтенд своим `readErrorMessage`.

**Правил правки здесь нет.** Тело `PATCH` уходит наверх как есть
(`UpdateCompanyDetailsRequest.forwarded()`), а что можно менять и какими должны
быть значения, решает основной API: вторая копия правил в кабинете разошлась бы с
оригиналом на первой же правке.

Создания строки нет: реквизиты засеяны миграцией основного API, и кабинет в
этот путь не вмешивается.
"""

from typing import Any

from fastapi import APIRouter, status

from app.main_api import (
    GATEWAY_RESPONSES,
    UNAUTHORIZED_RESPONSES,
    MainApiClient,
    call,
)
from app.schemas import CompanyDetails, ErrorResponse, UpdateCompanyDetailsRequest
from app.security import CurrentOperator

router = APIRouter(prefix="/company-details", tags=["company"])

# Путь основного API. Собран в одном месте: кабинет не должен знать о нём
# ничего, кроме этой строки.
MAIN_API_COMPANY_PATH = "/api/platform/company-details"

READ_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
}

UPDATE_RESPONSES: dict[int | str, dict[str, Any]] = {
    **READ_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Реквизиты поставщика не заведены",
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Значение не по формату или длиннее колонки — текст основного API",
    },
}


@router.get(
    "",
    response_model=CompanyDetails,
    summary="Реквизиты поставщика",
    responses=READ_RESPONSES,
)
def read_company_details(_operator: CurrentOperator, client: MainApiClient) -> CompanyDetails:
    """Реквизиты поставщика из основного API.

    Пустая строка — тоже успех: основной API отвечает `200` со всеми полями
    `null`, и кабинет отдаёт это как есть. Экран показывает пустую форму, а
    печатная форма печатает заглушку.
    """
    response = call(client, "GET", MAIN_API_COMPANY_PATH)
    return CompanyDetails.model_validate(response.json())


@router.patch(
    "",
    response_model=CompanyDetails,
    summary="Изменить реквизиты поставщика",
    responses=UPDATE_RESPONSES,
)
def update_company_details(
    payload: UpdateCompanyDetailsRequest,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> CompanyDetails:
    """Передать правку в основной API и вернуть обновлённую строку.

    Присланные поля уходят наверх как есть: пустое значение, формат и длины —
    правило основного API, и его `422` клиент получает дословно. Непереданное
    поле не обнуляется: `forwarded()` отдаёт только присланное.
    """
    response = call(
        client,
        "PATCH",
        MAIN_API_COMPANY_PATH,
        json=payload.forwarded(),
    )
    return CompanyDetails.model_validate(response.json())
