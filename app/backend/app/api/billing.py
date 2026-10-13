"""Счета организации: покупка тарифа, статусы и печатные формы.

Роутер закрытого кабинета, но **не** рабочих разделов: на закрытом пробном
периоде покупка обязана работать (ради неё кабинет и открывается), поэтому
вместо `SubscribedUser` здесь стоит `ActiveUser`. Правка статуса и покупка
требуют роли с правом редактирования (`EditableMembership`), чтение счетов и
скачивание файлов — любого участия в организации (`Membership`).

Коды отказа выбраны так, чтобы не подтверждать существование чужих данных:
чужой счёт отвечает `404`, а не `403`. `403` остаётся за неактивированным
кабинетом и ролью без права правки.

Счета живут отдельно от публичной таблицы `documents`: та отдаётся анониму, а
счёт — приватный документ организации.
"""

from datetime import UTC, datetime
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import billing_forms
from app.api.organization import (
    EDIT_ROLES,
    ORGANIZATION_EDIT_FORBIDDEN_DETAIL,
    ORGANIZATION_NOT_FOUND_DETAIL,
    EditableMembership,
    Membership,
)
from app.db import get_db
from app.invoice_status import (
    ACT_KIND,
    INVOICE_NOT_FOUND_DETAIL,
    NEW_STATUS,
    TARIFF_ALREADY_CHOSEN_DETAIL,
    change_status,
    status_label,
)
from app.models.invoice import (
    Invoice,
    InvoiceDocument,
    invoice_number,
    pending_invoice_number,
)
from app.models.organization import Organization
from app.models.tariff import Tariff
from app.pricing import format_invoice_amount
from app.schemas.invoice import (
    CreateInvoiceRequest,
    InvoiceResponse,
    InvoiceStatus,
    UpdateInvoiceStatusRequest,
)
from app.schemas.user import ErrorResponse
from app.security import ACTIVATION_REQUIRED_DETAIL, ActiveUser

router = APIRouter(prefix="/billing", tags=["billing"])
DbSession = Annotated[Session, Depends(get_db)]

TARIFF_NOT_FOUND_DETAIL = "Тариф не найден"
BUYER_REQUISITES_DETAIL = "Заполните название и ИНН организации на странице «Организация»"
ACT_NOT_FOUND_DETAIL = "Акт по счёту ещё не сформирован"

# Печатная форма — обычный HTML без BOM: кириллица объявлена `<meta charset>`,
# а BOM ломает файл при склейке и в чужом парсере.
HTML_MEDIA_TYPE = "text/html; charset=utf-8"

# 404 у этих роутов приходит с двумя разными текстами: нет организации у
# пользователя или нет счёта у организации. Оба перечислены в описании.
NOT_FOUND_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": f"{ORGANIZATION_NOT_FOUND_DETAIL}; {INVOICE_NOT_FOUND_DETAIL}",
    }
}

# 403 у правки: две разные причины — неактивированный кабинет и роль без права.
FORBIDDEN_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": (
            f"{ACTIVATION_REQUIRED_DETAIL} — кабинет не активирован; "
            f"{ORGANIZATION_EDIT_FORBIDDEN_DETAIL} — роль без права правки"
        ),
    }
}

UNAUTHORIZED_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": "Требуется авторизация",
    }
}

BROKEN_JSON_RESPONSES: dict[int | str, dict[str, Any]] = {
    # Тело, которое не декодируется как UTF-8, FastAPI превращает в 400
    # «There was an error parsing the body» — этот код обязан быть в схеме.
    status.HTTP_400_BAD_REQUEST: {
        "model": ErrorResponse,
        "description": "Тело запроса не разбирается как JSON",
    }
}

CONFLICT_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": f"{TARIFF_ALREADY_CHOSEN_DETAIL}; {BUYER_REQUISITES_DETAIL}",
    }
}


def _act_invoice_ids(db: Session, invoice_ids: list[int]) -> set[int]:
    """Счета, у которых уже есть акт. Одним запросом на весь список."""
    if not invoice_ids:
        return set()
    rows = db.scalars(
        select(InvoiceDocument.invoice_id).where(
            InvoiceDocument.invoice_id.in_(invoice_ids),
            InvoiceDocument.kind == ACT_KIND,
        )
    )
    return set(rows)


def _response(invoice: Invoice, has_act: bool, can_manage: bool) -> InvoiceResponse:
    """Ответ по строке счёта: подписи статуса и суммы собирает сервер."""
    return InvoiceResponse(
        id=invoice.id,
        number=invoice.number,
        # В колонке `VARCHAR(20)` набор значений держит `CHECK` по тем же
        # статусам, что объявляет `InvoiceStatus`; приведение говорит об этом
        # типизатору, а не ослабляет проверку.
        status=cast(InvoiceStatus, invoice.status),
        status_label=status_label(invoice.status),
        amount=invoice.amount,
        currency=invoice.currency,
        amount_label=format_invoice_amount(invoice.amount, invoice.currency, invoice.tariff_period),
        tariff_name=invoice.tariff_name,
        tariff_period=invoice.tariff_period,
        buyer_name=invoice.buyer_name,
        buyer_inn=invoice.buyer_inn,
        buyer_kpp=invoice.buyer_kpp,
        buyer_ogrn=invoice.buyer_ogrn,
        buyer_address=invoice.buyer_address,
        has_act=has_act,
        can_manage=can_manage,
        paid_at=invoice.paid_at,
        created_at=invoice.created_at,
    )


def _one_response(db: Session, invoice: Invoice, membership: Membership) -> InvoiceResponse:
    return _response(
        invoice,
        invoice.id in _act_invoice_ids(db, [invoice.id]),
        membership.role in EDIT_ROLES,
    )


def _load_own_invoice(db: Session, membership: Membership, invoice_id: int) -> Invoice:
    """Счёт своей организации. Чужой — `404`, а не `403`.

    Существование чужих счетов не подтверждается: по коду ответа нельзя
    отличить «такого счёта нет» от «он не ваш».
    """
    invoice = db.scalar(
        select(Invoice).where(
            Invoice.id == invoice_id,
            Invoice.organization_id == membership.organization_id,
        )
    )
    if invoice is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, INVOICE_NOT_FOUND_DETAIL)
    return invoice


def _html_response(content: str, filename: str) -> Response:
    return Response(
        content=content,
        media_type=HTML_MEDIA_TYPE,
        headers={"Content-Disposition": billing_forms.content_disposition(filename)},
    )


@router.post(
    "/invoices",
    status_code=status.HTTP_201_CREATED,
    response_model=InvoiceResponse,
    summary="Выставить счёт за тариф",
    responses={
        **UNAUTHORIZED_RESPONSES,
        **FORBIDDEN_RESPONSES,
        **BROKEN_JSON_RESPONSES,
        **NOT_FOUND_RESPONSES,
        **CONFLICT_RESPONSES,
        status.HTTP_200_OK: {
            "model": InvoiceResponse,
            "description": "Неоплаченный счёт уже есть — возвращается он же",
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "Тело запроса не подходит по схеме",
        },
    },
)
def purchase_invoice(
    payload: CreateInvoiceRequest,
    _user: ActiveUser,
    membership: EditableMembership,
    db: DbSession,
    response: Response,
) -> InvoiceResponse:
    """«Купить» на `/pricing`: выставить организации счёт за тариф.

    Проверки идут в порядке, который задаёт смысл отказа: сначала «тариф уже
    куплен», потом «такого тарифа нет», потом «некуда выставлять» (нет названия
    или ИНН) и лишь затем «счёт уже выставлен».

    Повторное нажатие не плодит счета: живой неоплаченный счёт возвращается как
    `200` с тем же телом, а новый не создаётся. Строка организации берётся под
    блокировку, иначе два одновременных клика прошли бы проверку вместе.
    """
    organization = db.scalar(
        select(Organization).where(Organization.id == membership.organization_id).with_for_update()
    )
    if organization is None:  # pragma: no cover - членство без организации невозможно
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)

    if organization.tariff_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_ALREADY_CHOSEN_DETAIL)

    tariff = db.get(Tariff, payload.tariff_id)
    if tariff is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, TARIFF_NOT_FOUND_DETAIL)

    if not organization.name or not organization.inn:
        raise HTTPException(status.HTTP_409_CONFLICT, BUYER_REQUISITES_DETAIL)

    existing = db.scalar(
        select(Invoice)
        .where(
            Invoice.organization_id == organization.id,
            Invoice.status == NEW_STATUS,
        )
        .order_by(Invoice.id.desc())
    )
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        return _one_response(db, existing, membership)

    invoice = Invoice(
        organization_id=organization.id,
        tariff_id=tariff.id,
        # Номер `СЧ-<год>-<id>` требует `id`, поэтому строка сначала сохраняется
        # с временным номером и получает окончательный в том же коммите.
        number=pending_invoice_number(),
        status=NEW_STATUS,
        amount=tariff.amount,
        currency=tariff.currency,
        # Снимок покупателя и предмета на момент покупки.
        buyer_name=organization.name,
        buyer_inn=organization.inn,
        buyer_kpp=organization.kpp,
        buyer_ogrn=organization.ogrn,
        buyer_address=organization.address,
        tariff_name=tariff.name,
        tariff_period=tariff.period,
    )
    db.add(invoice)
    db.flush()
    invoice.number = invoice_number(invoice.id, datetime.now(UTC).year)
    db.commit()
    db.refresh(invoice)
    return _one_response(db, invoice, membership)


@router.get(
    "/invoices",
    response_model=list[InvoiceResponse],
    summary="Счета организации",
    responses={**UNAUTHORIZED_RESPONSES, **FORBIDDEN_RESPONSES, **NOT_FOUND_RESPONSES},
)
def list_invoices(membership: Membership, db: DbSession) -> list[InvoiceResponse]:
    """Счета своей организации, свежие первыми. Читает любой участник."""
    invoices = list(
        db.scalars(
            select(Invoice)
            .where(Invoice.organization_id == membership.organization_id)
            .order_by(Invoice.created_at.desc(), Invoice.id.desc())
        )
    )
    acts = _act_invoice_ids(db, [invoice.id for invoice in invoices])
    can_manage = membership.role in EDIT_ROLES
    return [_response(invoice, invoice.id in acts, can_manage) for invoice in invoices]


@router.get(
    "/invoices/{invoice_id}",
    response_model=InvoiceResponse,
    summary="Счёт организации",
    responses={**UNAUTHORIZED_RESPONSES, **FORBIDDEN_RESPONSES, **NOT_FOUND_RESPONSES},
)
def read_invoice(invoice_id: int, membership: Membership, db: DbSession) -> InvoiceResponse:
    """Один счёт своей организации. Чужой — `404`."""
    return _one_response(db, _load_own_invoice(db, membership, invoice_id), membership)


@router.patch(
    "/invoices/{invoice_id}",
    response_model=InvoiceResponse,
    summary="Изменить статус счёта",
    responses={
        **UNAUTHORIZED_RESPONSES,
        **FORBIDDEN_RESPONSES,
        **BROKEN_JSON_RESPONSES,
        **NOT_FOUND_RESPONSES,
        **CONFLICT_RESPONSES,
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "Статус не из разрешённого набора или тело не по схеме",
        },
    },
)
def update_invoice_status(
    invoice_id: int,
    payload: UpdateInvoiceStatusRequest,
    membership: EditableMembership,
    db: DbSession,
) -> InvoiceResponse:
    """Смена статуса. Все переходы и тексты отказов — в `app/invoice_status.py`.

    Оплата здесь же привязывает организации тариф счёта и заводит акт: это одна
    транзакция, и частично применённой она быть не должна.
    """
    invoice = _load_own_invoice(db, membership, invoice_id)
    updated = change_status(db, invoice, payload.status)
    return _one_response(db, updated, membership)


@router.get(
    "/invoices/{invoice_id}/file",
    summary="Скачать счёт",
    response_class=Response,
    responses={
        **UNAUTHORIZED_RESPONSES,
        **FORBIDDEN_RESPONSES,
        **NOT_FOUND_RESPONSES,
        status.HTTP_200_OK: {
            "content": {HTML_MEDIA_TYPE: {}},
            "description": "Печатная форма счёта отдельным файлом",
        },
    },
)
def download_invoice(invoice_id: int, membership: Membership, db: DbSession) -> Response:
    """Счёт на скачивание. Доступ как у чтения: любой участник организации."""
    invoice = _load_own_invoice(db, membership, invoice_id)
    return _html_response(billing_forms.invoice_html(invoice), f"invoice-{invoice.number}.html")


@router.get(
    "/invoices/{invoice_id}/act-file",
    summary="Скачать акт",
    response_class=Response,
    responses={
        **UNAUTHORIZED_RESPONSES,
        **FORBIDDEN_RESPONSES,
        status.HTTP_404_NOT_FOUND: {
            "model": ErrorResponse,
            "description": f"{ORGANIZATION_NOT_FOUND_DETAIL}; {INVOICE_NOT_FOUND_DETAIL}; "
            f"{ACT_NOT_FOUND_DETAIL}",
        },
        status.HTTP_200_OK: {
            "content": {HTML_MEDIA_TYPE: {}},
            "description": "Печатная форма акта отдельным файлом",
        },
    },
)
def download_act(invoice_id: int, membership: Membership, db: DbSession) -> Response:
    """Акт на скачивание. До оплаты акта нет — `404`."""
    invoice = _load_own_invoice(db, membership, invoice_id)
    if invoice.id not in _act_invoice_ids(db, [invoice.id]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, ACT_NOT_FOUND_DETAIL)
    return _html_response(billing_forms.act_html(invoice), f"act-{invoice.number}.html")
