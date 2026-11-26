"""Журнал действий всех организаций в кабинете оператора: прокси в основной API.

Кабинет только пробрасывает запрос: лента, период, курсор и `total` считаются в
основном API (`GET /api/platform/journal`, `app/backend/app/api/platform_journal.py`).
Здесь - сессия оператора на входе и сервисный токен на выходе.

Наверх уходят только параметры, которые клиент реально передал: отсутствующий
параметр не подменяется значением кабинета, чтобы правила периода и вида решал
основной API. Ответ проверяется схемами кабинета, но не переписывается; тексты
отказов основного API (`422`, `502`) доходят до экрана дословно.
"""

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Query, status

from app.main_api import (
    GATEWAY_RESPONSES,
    UNAUTHORIZED_RESPONSES,
    MainApiClient,
    call,
)
from app.schemas import ErrorResponse, JournalPage
from app.security import CurrentOperator

router = APIRouter(prefix="/journal", tags=["journal"])

# Путь основного API. Вынесен в константу: прокси не строит путь из частей.
MAIN_API_JOURNAL_PATH = "/api/platform/journal"

# Лимит страницы - тот же потолок, что у основного API (`app.journal.MAX_LIMIT`).
MAX_LIMIT = 200

LIST_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Отказ основного API по периоду, курсору, лимиту или виду - текст дословно",
    },
}


@router.get(
    "",
    response_model=JournalPage,
    summary="Журнал действий всех организаций",
    responses=LIST_RESPONSES,
)
def list_journal(
    _operator: CurrentOperator,
    client: MainApiClient,
    kind: Annotated[str | None, Query()] = None,
    date_from: Annotated[date | None, Query()] = None,
    date_to: Annotated[date | None, Query()] = None,
    limit: Annotated[int | None, Query(ge=1, le=MAX_LIMIT)] = None,
    cursor: Annotated[str | None, Query()] = None,
) -> JournalPage:
    """Страница ленты по всем организациям. Параметры, не переданные клиентом, не уходят наверх."""
    params: dict[str, Any] = {}
    if kind is not None:
        params["kind"] = kind
    if date_from is not None:
        params["date_from"] = date_from.isoformat()
    if date_to is not None:
        params["date_to"] = date_to.isoformat()
    if limit is not None:
        params["limit"] = limit
    if cursor is not None:
        params["cursor"] = cursor
    response = call(client, "GET", MAIN_API_JOURNAL_PATH, params=params)
    return JournalPage.model_validate(response.json())
