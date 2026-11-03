"""Счета платформы: кабинет — тонкий прокси к основному API.

Данных кабинет не хранит: реестр счетов всех организаций, смена статуса и
скачивание печатных форм идут в основной API по внутренней сети с сервисным
токеном в заголовке `X-Operator-Token`. Здесь только HTTP: сессия кабинета,
запрос наверх и перевод отказов.

Клиент, секрет контура и правила перевода отказов — общие с разделами
организаций и пользователей (`app/main_api.py`). Тексты отказов основного API
проходят насквозь: «Счёт не найден», «Так нельзя изменить статус счёта» и «Акт
по счёту ещё не сформирован» клиент получает дословно, а не в пересказе.

**Правил статуса здесь нет.** Тело `PATCH` уходит наверх как есть
(`UpdateInvoiceStatusRequest.forwarded`), а разрешённые переходы проверяет
основной API (`app/backend/app/invoice_status.py`) — вторая копия правил в
кабинете разошлась бы с оригиналом на первой же правке.

**Файлы отдаются байтами.** Ответ файловых ручек не разбирается как JSON:
тело проксируется как есть, а тип и имя файла берутся из заголовков ответа
основного API — имя собирает он (`invoice-<номер>.pdf` / `act-<номер>.pdf`),
и кабинет его не переписывает.
"""

from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Query, Response, status

from app.main_api import (
    GATEWAY_RESPONSES,
    UNAUTHORIZED_RESPONSES,
    MainApiClient,
    call,
)
from app.schemas import (
    ErrorResponse,
    PlatformInvoice,
    PlatformInvoicePage,
    UpdateInvoiceStatusRequest,
)
from app.security import CurrentOperator

router = APIRouter(prefix="/invoices", tags=["invoices"])

# Путь основного API. Собран в одном месте: кабинет не должен знать о нём
# ничего, кроме этой строки.
MAIN_API_INVOICES_PATH = "/api/platform/invoices"

DEFAULT_LIMIT = 50
MAX_LIMIT = 100
MAX_SEARCH_LENGTH = 100

# Заголовки файлового ответа. Переносятся с ответа основного API: имя файла
# собирает он, а тип у печатных форм всегда один и тот же.
CONTENT_TYPE_HEADER = "Content-Type"
CONTENT_DISPOSITION_HEADER = "Content-Disposition"
FILE_MEDIA_TYPE = "application/pdf"

PageLimit = Annotated[int, Query(ge=1, le=MAX_LIMIT)]
PageOffset = Annotated[int, Query(ge=0)]
SearchQuery = Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH)]
# Значение статуса не проверяется здесь: набор допустимых значений и правило
# перехода живут в основном API, а его `422` уходит клиенту дословно.
StatusQuery = Annotated[str | None, Query(alias="status")]

LIST_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "`limit` вне 1..100, `offset` меньше нуля, `search` длиннее 100 "
        "символов или `status` не из разрешённого набора",
    },
}

UPDATE_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Счёт не найден",
    },
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": "Так нельзя изменить статус счёта",
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Статус не из разрешённого набора или тело не по схеме — отказ "
        "основного API",
    },
}

FILE_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Счёт не найден",
    },
    status.HTTP_200_OK: {
        "content": {FILE_MEDIA_TYPE: {}},
        "description": "Байты печатной формы счёта — те же, что отдал основной API",
    },
}

ACT_FILE_RESPONSES: dict[int | str, dict[str, Any]] = {
    **UNAUTHORIZED_RESPONSES,
    **GATEWAY_RESPONSES,
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Счёт не найден; Акт по счёту ещё не сформирован",
    },
    status.HTTP_200_OK: {
        "content": {FILE_MEDIA_TYPE: {}},
        "description": "Байты печатной формы акта — те же, что отдал основной API",
    },
}


def _file_response(response: httpx.Response) -> Response:
    """Файл вниз без разбора тела: байты и заголовки — из ответа основного API.

    `.json()` на файловой ручке вызывать нельзя: тело — PDF, а не JSON. Тип
    берётся из `Content-Type`, имя файла — из `Content-Disposition`; если
    основного заголовка нет (основной API его не прислал), клиент получает тот
    же тип, что и у печатных форм.
    """
    headers: dict[str, str] = {}
    disposition = response.headers.get(CONTENT_DISPOSITION_HEADER)
    if disposition is not None:
        headers[CONTENT_DISPOSITION_HEADER] = disposition
    return Response(
        content=response.content,
        media_type=response.headers.get(CONTENT_TYPE_HEADER, FILE_MEDIA_TYPE),
        headers=headers,
    )


@router.get(
    "",
    response_model=PlatformInvoicePage,
    summary="Список счетов",
    responses=LIST_RESPONSES,
)
def list_invoices(
    _operator: CurrentOperator,
    client: MainApiClient,
    limit: PageLimit = DEFAULT_LIMIT,
    offset: PageOffset = 0,
    status_value: StatusQuery = None,
    search: SearchQuery = None,
) -> PlatformInvoicePage:
    """Страница реестра счетов всех организаций из основного API.

    `status` и `search` уходят наверх, только если клиент их прислал: фильтры
    необязательные, а пустые значения разбирает уже основной API — своих правил
    фильтрации у кабинета нет.
    """
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if status_value is not None:
        params["status"] = status_value
    if search is not None:
        params["search"] = search
    response = call(client, "GET", MAIN_API_INVOICES_PATH, params=params)
    return PlatformInvoicePage.model_validate(response.json())


@router.patch(
    "/{invoice_id}",
    response_model=PlatformInvoice,
    summary="Изменить статус счёта",
    responses=UPDATE_RESPONSES,
)
def update_invoice_status(
    invoice_id: int,
    payload: UpdateInvoiceStatusRequest,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> PlatformInvoice:
    """Передать оплату или отмену в основной API и вернуть обновлённую строку.

    Тело уходит наверх как есть: набор разрешённых переходов и текст отказа
    «Так нельзя изменить статус счёта» — правило основного API, а кабинет
    передаёт его дословно.
    """
    response = call(
        client,
        "PATCH",
        f"{MAIN_API_INVOICES_PATH}/{invoice_id}",
        json=payload.forwarded(),
    )
    return PlatformInvoice.model_validate(response.json())


@router.get(
    "/{invoice_id}/file",
    summary="Скачать счёт",
    response_class=Response,
    responses=FILE_RESPONSES,
)
def download_invoice(
    invoice_id: int,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> Response:
    """Печатная форма счёта: байты основного API вниз без пересборки."""
    response = call(client, "GET", f"{MAIN_API_INVOICES_PATH}/{invoice_id}/file")
    return _file_response(response)


@router.get(
    "/{invoice_id}/act-file",
    summary="Скачать акт",
    response_class=Response,
    responses=ACT_FILE_RESPONSES,
)
def download_act(
    invoice_id: int,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> Response:
    """Печатная форма акта: до оплаты основного API отвечает `404`.

    Отказ проходит насквозь с текстом основного API, поэтому кабинет не
    проверяет «оплачен ли счёт» повторно: правило одно и живёт наверху.
    """
    response = call(client, "GET", f"{MAIN_API_INVOICES_PATH}/{invoice_id}/act-file")
    return _file_response(response)
