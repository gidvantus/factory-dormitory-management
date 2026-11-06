"""Каталог решений магазина: кабинет — тонкий прокси к основному API (#188).

Данных кабинет не хранит: весь каталог, правка полей и снятие с продажи идут в
основной API по внутренней сети с сервисным токеном в заголовке
`X-Operator-Token`. Здесь только HTTP: сессия кабинета, запрос наверх и перевод
отказов.

Клиент, секрет контура и правила перевода отказов — общие с остальными разделами
(`app/main_api.py`). Тексты отказов основного API проходят насквозь: «Решение не
найдено», «Решение с таким названием уже есть» и сообщения валидатора (`422`)
клиент получает дословно, а не в пересказе.

**Правил правки здесь нет.** Тело `PATCH` уходит наверх как есть
(`UpdateSolutionRequest.forwarded()`), а что можно менять и какими должны быть
значения, решает основной API: вторая копия правил в кабинете разошлась бы с
оригиналом на первой же правке.

**`DELETE` — это `204` без тела.** Снятие с продажи не удаляет строку: решение
пропадает из магазина клиента, а право организации на него продолжает
действовать, и платная функция на сервере работает по-прежнему. Кабинет тела не
собирает — пустой ответ основного API уходит вниз как есть (`app/main_api.call`
принимает и `200`, и `204`).
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
    Solution,
    UpdateSolutionRequest,
)
from app.security import CurrentOperator

router = APIRouter(prefix="/solutions", tags=["solutions"])

# Путь основного API. Собран в одном месте: кабинет не должен знать о нём
# ничего, кроме этой строки.
MAIN_API_SOLUTIONS_PATH = "/api/platform/solutions"

LIST_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
}

UPDATE_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Решение не найдено",
    },
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": "Решение с таким названием уже есть",
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Непустое название, цена, валюта, период, порядок или состояние вне "
        "правил — отказ основного API",
    },
}

DELETE_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Решение не найдено",
    },
}


@router.get(
    "",
    response_model=list[Solution],
    summary="Список решений",
    responses=LIST_RESPONSES,
)
def list_solutions(_operator: CurrentOperator, client: MainApiClient) -> list[Solution]:
    """Весь каталог из основного API, включая снятые с продажи строки.

    Пагинации нет: строк каталога единицы, и основной API отдаёт такой же плоский
    список в порядке `position`, `id` — в том же, в каком его видит покупатель.
    """
    response = call(client, "GET", MAIN_API_SOLUTIONS_PATH)
    return [Solution.model_validate(item) for item in response.json()]


@router.patch(
    "/{solution_id}",
    response_model=Solution,
    summary="Изменить решение",
    responses=UPDATE_RESPONSES,
)
def update_solution(
    solution_id: int,
    payload: UpdateSolutionRequest,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> Solution:
    """Передать правку в основной API и вернуть обновлённую строку.

    Присланные поля уходят наверх как есть: занятость названия и правила
    значений — правило основного API, и его `409`/`422` клиент получает дословно.
    `price_label` в ответе пересчитан основным API: кабинет его не собирает.
    """
    response = call(
        client,
        "PATCH",
        f"{MAIN_API_SOLUTIONS_PATH}/{solution_id}",
        json=payload.forwarded(),
    )
    return Solution.model_validate(response.json())


@router.delete(
    "/{solution_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Снять решение с продажи",
    responses=DELETE_RESPONSES,
)
def delete_solution(
    solution_id: int,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> Response:
    """Снять решение с продажи: основной API отвечает `204`, тело не собирается.

    Строку не удаляем: на неё ссылаются счета и права организаций. Повторный
    вызов на уже скрытой строке — тот же `204`: команда идемпотентна, и кабинет
    не различает «снял только что» и «уже снят».
    """
    call(client, "DELETE", f"{MAIN_API_SOLUTIONS_PATH}/{solution_id}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
