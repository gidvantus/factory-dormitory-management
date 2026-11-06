"""Тарифы платформы: кабинет — тонкий прокси к основному API.

Данных кабинет не хранит: весь прайс, правка полей и снятие с продажи идут в
основной API по внутренней сети с сервисным токеном в заголовке
`X-Operator-Token`. Здесь только HTTP: сессия кабинета, запрос наверх и перевод
отказов.

Клиент, секрет контура и правила перевода отказов — общие с разделами
организаций, пользователей и счетов (`app/main_api.py`). Тексты отказов
основного API проходят насквозь: «Тариф не найден», «Тариф с таким названием уже
есть» и сообщения валидатора (`422`) клиент получает дословно, а не в пересказе.

**Правил правки здесь нет.** Тело `PATCH` уходит наверх как есть
(`UpdateTariffRequest.forwarded()`), а что можно менять и какими должны быть
значения, решает основной API: вторая копия правил в кабинете разошлась бы с
оригиналом на первой же правке.

**`DELETE` — это `204` без тела.** Снятие с продажи не удаляет строку: тариф
пропадает из публичного прайса, а организация, которой он назначен, продолжает
его видеть. Кабинет тела не собирает — пустой ответ основного API уходит вниз
как есть (`app/main_api.call` принимает и `200`, и `204`).
"""

from typing import Any

from fastapi import APIRouter, Response, status

from app.main_api import (
    GATEWAY_RESPONSES,
    UNAUTHORIZED_RESPONSES,
    MainApiClient,
    call,
)
from app.schemas import (
    ErrorResponse,
    Tariff,
    UpdateTariffRequest,
)
from app.security import CurrentOperator

router = APIRouter(prefix="/tariffs", tags=["tariffs"])

# Путь основного API. Собран в одном месте: кабинет не должен знать о нём
# ничего, кроме этой строки.
MAIN_API_TARIFFS_PATH = "/api/platform/tariffs"

LIST_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
}

UPDATE_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Тариф не найден",
    },
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": "Тариф с таким названием уже есть",
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Непустое название, цена, период или количество пользователей вне "
        "правил — отказ основного API",
    },
}

DELETE_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Тариф не найден",
    },
}


@router.get(
    "",
    response_model=list[Tariff],
    summary="Список тарифов",
    responses=LIST_RESPONSES,
)
def list_tariffs(_operator: CurrentOperator, client: MainApiClient) -> list[Tariff]:
    """Весь прайс из основного API, включая снятые с продажи строки.

    Пагинации нет: строк в прайсе около пятнадцати, и основной API отдаёт такой
    же плоский список в порядке `position`, `id`.
    """
    response = call(client, "GET", MAIN_API_TARIFFS_PATH)
    return [Tariff.model_validate(item) for item in response.json()]


@router.patch(
    "/{tariff_id}",
    response_model=Tariff,
    summary="Изменить тариф",
    responses=UPDATE_RESPONSES,
)
def update_tariff(
    tariff_id: int,
    payload: UpdateTariffRequest,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> Tariff:
    """Передать правку в основной API и вернуть обновлённую строку.

    Присланные поля уходят наверх как есть: занятость названия и правила
    значений — правило основного API, и его `409`/`422` клиент получает
    дословно.
    """
    response = call(
        client,
        "PATCH",
        f"{MAIN_API_TARIFFS_PATH}/{tariff_id}",
        json=payload.forwarded(),
    )
    return Tariff.model_validate(response.json())


@router.delete(
    "/{tariff_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Снять тариф с продажи",
    responses=DELETE_RESPONSES,
)
def delete_tariff(
    tariff_id: int,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> Response:
    """Снять тариф с продажи: основной API отвечает `204`, тело не собирается.

    Повторный вызов на уже скрытой строке — тот же `204`: команда идемпотентна, и
    кабинет не различает «снял только что» и «уже снят».
    """
    call(client, "DELETE", f"{MAIN_API_TARIFFS_PATH}/{tariff_id}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
