"""Счета платформы: реестр всех организаций, оплата, отмена и печатные формы.

Контур отдельный, тот же, что у организаций (`app/api/platform_organizations.py`)
и пользователей (`app/api/platform_users.py`): ручки открывает сервисный токен
кабинета оператора (`X-Operator-Token`), а не cookie основного кабинета. Своего
хранилища у кабинета нет — правила переходов, выдача прав и PDF остаются в
основном приложении.

Что здесь осознанно **не** так, как в кабинете клиента (`app/api/billing.py`):

* список — по **всем** организациям платформы, с фильтром по статусу и поиском
  по названию или ИНН организации. Организация у счёта обязательна (колонка
  `NOT NULL`), поэтому джойн внутренний: счёта без организации не бывает;
* `can_manage` всегда `true`: право даёт сервисный токен, ролей организации в
  этом контуре нет;
* правил переходов здесь нет вовсе — `PATCH` вызывает
  `app/invoice_status.py::change_status`, единственное место, где живут
  разрешённые переходы и тексты отказов. Поэтому «оплатить» из кабинета
  оператора — это ровно та же операция, что «оплатить» из кабинета клиента:
  появляется акт, у организации выдаётся или продлевается тариф либо право.

Представление счёта (подписи, признак акта, PDF-ответ) берётся из
`app/invoices.py` — того же модуля, что у кабинета клиента: второй его копии
здесь нет.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.orm import Session

from app import invoice_files
from app.db import get_db
from app.invoice_status import INVALID_STATUS_DETAIL, INVOICE_NOT_FOUND_DETAIL, change_status
from app.invoices import (
    ACT_NOT_FOUND_DETAIL,
    PDF_MEDIA_TYPE,
    act_invoice_ids,
    invoice_response,
    pdf_response,
)
from app.models.invoice import Invoice
from app.models.organization import Organization
from app.schemas.invoice import InvoiceStatus, UpdateInvoiceStatusRequest
from app.schemas.platform_invoice import PlatformInvoice, PlatformInvoicePage
from app.schemas.user import ErrorResponse
from app.security import INVALID_OPERATOR_TOKEN_DETAIL, require_operator_service
from app.sql_like import ESCAPE_CHARACTER, like_pattern

# Зависимость стоит на роутере целиком: ни одна ручка платформенного контура не
# открывается без сервисного токена, и новая ручка не может её забыть.
router = APIRouter(
    prefix="/platform/invoices",
    tags=["platform"],
    dependencies=[Depends(require_operator_service)],
    responses={
        status.HTTP_401_UNAUTHORIZED: {
            "model": ErrorResponse,
            "description": INVALID_OPERATOR_TOKEN_DETAIL,
        },
    },
)

DbSession = Annotated[Session, Depends(get_db)]

# Умолчания и границы страницы те же, что у остальных списков платформы:
# `limit` 1..100, иначе один запрос вытянул бы все счета платформы.
DEFAULT_LIMIT = 50
MAX_LIMIT = 100
PageLimit = Annotated[int, Query(ge=1, le=MAX_LIMIT)]
PageOffset = Annotated[int, Query(ge=0)]

# Потолок поисковой подстроки: её длину задаёт клиент, а `ILIKE` по префиксу
# `%…%` индексов не использует.
MAX_SEARCH_LENGTH = 100
SearchQuery = Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH)]

LIST_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "`limit` вне 1..100, `offset` меньше нуля, `search` длиннее 100 "
        "символов или `status` не из разрешённого набора",
    },
}

UPDATE_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": INVOICE_NOT_FOUND_DETAIL,
    },
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": INVALID_STATUS_DETAIL,
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Статус не из разрешённого набора или тело не по схеме",
    },
}

INVOICE_FILE_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": INVOICE_NOT_FOUND_DETAIL,
    },
    status.HTTP_200_OK: {
        "content": {PDF_MEDIA_TYPE: {}},
        "description": "Печатная форма счёта отдельным файлом",
    },
}

ACT_FILE_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": f"{INVOICE_NOT_FOUND_DETAIL}; {ACT_NOT_FOUND_DETAIL}",
    },
    status.HTTP_200_OK: {
        "content": {PDF_MEDIA_TYPE: {}},
        "description": "Печатная форма акта отдельным файлом",
    },
}


def _search_condition(search: str) -> ColumnElement[bool]:
    """Подстрока без учёта регистра по названию **или** ИНН организации.

    Номер счёта поиском не ищется намеренно: постановка просит очередь «что не
    оплачено» по организациям, а не поиск конкретного документа.
    """
    pattern = like_pattern(search)
    return or_(
        Organization.name.ilike(pattern, escape=ESCAPE_CHARACTER),
        Organization.inn.ilike(pattern, escape=ESCAPE_CHARACTER),
    )


def _invoice_query() -> Any:
    """Выборка строки реестра: счёт и название организации, которой он выставлен.

    Джойн внутренний: платформа показывает счета **по организациям**, а
    `invoices.organization_id` объявлен `NOT NULL` — счёта без организации в
    схеме быть не может.
    """
    return select(Invoice, Organization.name).join(
        Organization, Organization.id == Invoice.organization_id
    )


def _to_platform_invoice(
    invoice: Invoice,
    organization_name: str | None,
    has_act: bool,
) -> PlatformInvoice:
    """Строка выборки → схема ответа.

    Поля счёта собирает `invoice_response` (то же представление, что в кабинете
    клиента), а организация дописывается здесь. `can_manage` — всегда `true`:
    право в платформенном контуре даёт сервисный токен, ролей организации здесь
    нет.
    """
    base = invoice_response(invoice, has_act, True)
    return PlatformInvoice(
        **base.model_dump(),
        organization_id=invoice.organization_id,
        organization_name=organization_name,
    )


def _load_invoice(db: Session, invoice_id: int) -> Invoice:
    """Счёт платформы по `id`. Неизвестный `id` — `404` с текстом основного API."""
    invoice = db.get(Invoice, invoice_id)
    if invoice is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, INVOICE_NOT_FOUND_DETAIL)
    return invoice


def _one_response(db: Session, invoice: Invoice) -> PlatformInvoice:
    """Ответ по одному счёту: организация и признак акта досчитываются здесь."""
    organization_name = db.scalar(
        select(Organization.name).where(Organization.id == invoice.organization_id)
    )
    has_act = invoice.id in act_invoice_ids(db, [invoice.id])
    return _to_platform_invoice(invoice, organization_name, has_act)


@router.get(
    "",
    response_model=PlatformInvoicePage,
    summary="Список счетов платформы",
    responses=LIST_RESPONSES,
)
def list_invoices(
    db: DbSession,
    limit: PageLimit = DEFAULT_LIMIT,
    offset: PageOffset = 0,
    status_filter: Annotated[InvoiceStatus | None, Query(alias="status")] = None,
    search: SearchQuery = None,
) -> PlatformInvoicePage:
    """Страница реестра счетов всех организаций: свежие сверху.

    Порядок — `created_at DESC, id DESC`: `id` вторым ключом делает страницы
    устойчивыми, когда два счёта созданы в одну секунду. Фильтры (`status`,
    `search`) применяются и к странице, и к отдельному `count`: `total` не
    зависит от `limit`/`offset`, и по нему фронт решает, есть ли ещё страница.

    `status` — точное значение из набора статусов (другое отвергает схема
    `422`); пустая строка фильтром не считается и до разбора доходит как
    ошибка ввода — форма фильтров пустой статус просто не присылает. `search`
    обрезается по пробелам: пустая подстрока — это отсутствие фильтра.
    """
    conditions: list[ColumnElement[bool]] = []
    if status_filter is not None:
        conditions.append(Invoice.status == status_filter)

    query = (search or "").strip()
    if query:
        conditions.append(_search_condition(query))

    total = (
        db.scalar(
            select(func.count())
            .select_from(Invoice)
            .join(Organization, Organization.id == Invoice.organization_id)
            .where(*conditions)
        )
        or 0
    )
    rows = db.execute(
        _invoice_query()
        .where(*conditions)
        .order_by(Invoice.created_at.desc(), Invoice.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    invoices = [row[0] for row in rows]
    acts = act_invoice_ids(db, [invoice.id for invoice in invoices])
    return PlatformInvoicePage(
        items=[
            _to_platform_invoice(invoice, row[1], invoice.id in acts)
            for row, invoice in zip(rows, invoices, strict=True)
        ],
        total=total,
    )


@router.patch(
    "/{invoice_id}",
    response_model=PlatformInvoice,
    summary="Изменить статус счёта",
    responses=UPDATE_RESPONSES,
)
def update_invoice_status(
    invoice_id: int,
    payload: UpdateInvoiceStatusRequest,
    db: DbSession,
) -> PlatformInvoice:
    """Оплата или отмена счёта из кабинета оператора.

    Переход выполняет `app/invoice_status.py::change_status`: здесь нет ни
    своего списка разрешённых переходов, ни своей выдачи тарифа. Поэтому
    `new → paid` из кабинета оператора делает ровно то же, что из кабинета
    клиента («оплата вносит кабинет оператора», #120), а запрещённый переход
    получает `409` с текстом `INVALID_STATUS_DETAIL`.
    """
    invoice = _load_invoice(db, invoice_id)
    updated = change_status(db, invoice, payload.status)
    return _one_response(db, updated)


@router.get(
    "/{invoice_id}/file",
    summary="Скачать счёт",
    response_class=Response,
    responses=INVOICE_FILE_RESPONSES,
)
def download_invoice(invoice_id: int, db: DbSession) -> Response:
    """Счёт на скачивание: байты и имя файла — как в кабинете клиента.

    Байты берутся из файлового хранилища (`app/invoice_files.py`): форма
    собирается один раз, при первом скачивании, и дальше отдаётся сохранённая.
    """
    invoice = _load_invoice(db, invoice_id)
    content = invoice_files.read_or_store(db, invoice, invoice_files.INVOICE_PURPOSE)
    return pdf_response(content, f"invoice-{invoice.number}.pdf")


@router.get(
    "/{invoice_id}/act-file",
    summary="Скачать акт",
    response_class=Response,
    responses=ACT_FILE_RESPONSES,
)
def download_act(invoice_id: int, db: DbSession) -> Response:
    """Акт на скачивание. До оплаты акта нет — `404` с текстом `ACT_NOT_FOUND_DETAIL`.

    Проверка «акт уже появился» остаётся здесь и файла не создаёт: акт заводит
    только оплата (`app/invoice_status.py`).
    """
    invoice = _load_invoice(db, invoice_id)
    if invoice.id not in act_invoice_ids(db, [invoice.id]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, ACT_NOT_FOUND_DETAIL)
    content = invoice_files.read_or_store(db, invoice, invoice_files.ACT_PURPOSE)
    return pdf_response(content, f"act-{invoice.number}.pdf")
