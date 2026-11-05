"""Счета организации: покупка тарифа, решения или мест, статусы и печатные формы.

Роутер закрытого кабинета, но **не** рабочих разделов: на закрытом пробном
периоде покупка обязана работать (ради неё кабинет и открывается), поэтому
вместо `SubscribedUser` здесь стоит `ActiveUser`. Правка статуса и покупка
требуют роли с правом редактирования (`EditableMembership`), чтение счетов и
скачивание файлов — любого участия в организации (`Membership`).

Предмет счёта бывает трёх видов: тариф (`item_kind = 'tariff'`), решение
магазина улучшений (`item_kind = 'solution'`) и докупленные сверх тарифа места
(`item_kind = 'seats'`). Вид выбирается телом запроса — ровно одно из полей
`tariff_id`/`solution_id`/`seats`, — и определяет и проверки покупки, и то, что
происходит при оплате (`app/invoice_status.py`). Снимок предмета у всех видов
лежит в `tariff_name`/`tariff_period`: печатные формы счёта и акта читают эти
колонки и о решениях и местах ничего не знают.

Места — не строка каталога решений с количеством: в теле едет количество, а
цену, сумму и предмет счёта считает сервер по строке каталога `extra_member`
(`app/seats.py`). Клиент не присылает деньги и не собирает сумму сам.

Коды отказа выбраны так, чтобы не подтверждать существование чужих данных:
чужой счёт отвечает `404`, а не `403`. `403` остаётся за неактивированным
кабинетом и ролью без права правки.

Счета живут отдельно от публичной таблицы `documents`: та отдаётся анониму, а
счёт — приватный документ организации.
"""

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import ColumnElement, select
from sqlalchemy.orm import Session

from app import invoice_files
from app.api.organization import (
    EDIT_ROLES,
    ORGANIZATION_EDIT_FORBIDDEN_DETAIL,
    ORGANIZATION_NOT_FOUND_DETAIL,
    EditableMembership,
    Membership,
)
from app.db import get_db
from app.invoice_status import (
    INVOICE_NOT_FOUND_DETAIL,
    NEW_STATUS,
    change_status,
)
from app.invoices import (
    ACT_NOT_FOUND_DETAIL,
    PDF_MEDIA_TYPE,
    act_invoice_ids,
    invoice_response,
    pdf_response,
)
from app.models.invoice import (
    SEATS_ITEM_KIND,
    SOLUTION_ITEM_KIND,
    TARIFF_ITEM_KIND,
    Invoice,
    invoice_number,
    pending_invoice_number,
)
from app.models.organization import Organization
from app.models.solution import Solution
from app.models.tariff import Tariff
from app.offer import OFFER_ACCEPTANCE_REQUIRED_DETAIL, has_acceptance, record_acceptance
from app.schemas.invoice import (
    CreateInvoiceRequest,
    InvoiceResponse,
    UpdateInvoiceStatusRequest,
)
from app.schemas.user import ErrorResponse
from app.seats import (
    EXTRA_MEMBER_CODE,
    SEATS_NOT_FOR_SALE_DETAIL,
    SEATS_REQUIRE_TARIFF_DETAIL,
    SEATS_UNLIMITED_TARIFF_DETAIL,
    catalog_row,
)
from app.security import ACTIVATION_REQUIRED_DETAIL, ActiveUser
from app.subscription import (
    TARIFF_ALREADY_BOUGHT_DETAIL,
    free_slot,
    organization_subscription,
)

router = APIRouter(prefix="/billing", tags=["billing"])
DbSession = Annotated[Session, Depends(get_db)]

TARIFF_NOT_FOUND_DETAIL = "Тариф не найден"
SOLUTION_NOT_FOUND_DETAIL = "Решение не найдено"
BUYER_REQUISITES_DETAIL = "Заполните название и ИНН организации на странице «Организация»"

# 404 у этих роутов приходит с тремя разными текстами: нет организации у
# пользователя, нет счёта у организации или нет предмета покупки. Все в описании.
NOT_FOUND_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": f"{ORGANIZATION_NOT_FOUND_DETAIL}; {INVOICE_NOT_FOUND_DETAIL}; "
        f"{TARIFF_NOT_FOUND_DETAIL}; {SOLUTION_NOT_FOUND_DETAIL}; {SEATS_NOT_FOR_SALE_DETAIL}",
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
        "description": (
            f"{TARIFF_ALREADY_BOUGHT_DETAIL}; {BUYER_REQUISITES_DETAIL}; "
            f"{SEATS_REQUIRE_TARIFF_DETAIL}; {SEATS_UNLIMITED_TARIFF_DETAIL}"
        ),
    }
}


def _one_response(db: Session, invoice: Invoice, membership: Membership) -> InvoiceResponse:
    return invoice_response(
        invoice,
        invoice.id in act_invoice_ids(db, [invoice.id]),
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


@router.post(
    "/invoices",
    status_code=status.HTTP_201_CREATED,
    response_model=InvoiceResponse,
    summary="Выставить счёт за тариф, решение или места",
    responses={
        **UNAUTHORIZED_RESPONSES,
        **FORBIDDEN_RESPONSES,
        **BROKEN_JSON_RESPONSES,
        **NOT_FOUND_RESPONSES,
        **CONFLICT_RESPONSES,
        status.HTTP_200_OK: {
            "model": InvoiceResponse,
            "description": "Неоплаченный счёт за тот же предмет уже есть — возвращается он же",
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "Тело запроса не подходит по схеме: предмет не указан или указан "
            "дважды, количество мест вне 1…100, либо тариф покупается без отметки оферты — "
            f"{OFFER_ACCEPTANCE_REQUIRED_DETAIL}",
        },
    },
)
def purchase_invoice(
    payload: CreateInvoiceRequest,
    user: ActiveUser,
    membership: EditableMembership,
    db: DbSession,
    response: Response,
) -> InvoiceResponse:
    """«Купить»: выставить организации счёт за тариф, решение или места.

    Проверки идут в порядке, который задаёт смысл отказа: сначала «продлевать
    некуда» (оба слота подписки заняты — это условие касается только тарифов),
    потом «такого предмета нет», потом «некуда выставлять» (нет названия или ИНН)
    и лишь затем «счёт уже выставлен».

    **Продление — это второй слот.** Пока текущий оплаченный период жив, счёт за
    второй тариф выставляется на будущий период, и он начнётся ровно в день
    после последнего оплаченного (`app/subscription.py`). Третий тариф до
    наступления будущего не продаётся: `409` с текстом
    `TARIFF_ALREADY_BOUGHT_DETAIL`. Смены тарифа покупкой по-прежнему нет —
    меняется только срок в том же слоте, когда период истёк.

    **Места покупаются только сверх живого тарифа.** Порядок отказов важен и
    дословен: нет действующего тарифа — `409 SEATS_REQUIRE_TARIFF_DETAIL`
    (докупать нечего, сначала тариф); тариф безлимитный — `409
    SEATS_UNLIMITED_TARIFF_DETAIL` (предела нет, место ничего не добавляет);
    строки каталога нет или она скрыта — `404 SEATS_NOT_FOR_SALE_DETAIL`. Сумма
    считается здесь: цена места из строки каталога × количество из тела. За
    места оферта не требуется — это не подписка, а доплата к уже оплаченной.

    **Строка мест не покупается как решение.** Она видима в каталоге (`is_visible
    = true`) — по ней магазин рисует карточку, — поэтому путь `{ "solution_id":
    <её id> }` открыт и его надо закрыть: иначе оплата завела бы право на код
    `extra_member`, которого не читает ни одна ручка, а счётчик мест не вырос бы.
    Такой `solution_id` получает `404 SOLUTION_NOT_FOUND_DETAIL` — как
    несуществующее решение; места же покупаются полем `seats`.

    Повторное нажатие не плодит счета: живой неоплаченный счёт **за тот же
    предмет** возвращается как `200` с тем же телом, а новый не создаётся. У
    мест предмет — «эта строка каталога и это количество»: два клика с разным
    количеством дают два счёта осознанно. Счёт за тариф, за решение и за места
    друг другу не мешают. Строка организации берётся под блокировку, иначе два
    одновременных клика прошли бы проверку вместе.

    Акцепт оферты пишется в ту же транзакцию, что и счёт: у только что созданного
    тарифного счёта — всегда (без отметки тело не прошло бы схему), у
    возвращаемого существующего — только если он ещё пуст. Здесь человек только
    что нажал «Купить» с отметкой, но подменять прежнюю дату согласия нельзя.
    Счёт за решение и за места покупается без отметки, и его `offer_*` остаются
    `NULL`.
    """
    organization = db.scalar(
        select(Organization).where(Organization.id == membership.organization_id).with_for_update()
    )
    if organization is None:  # pragma: no cover - членство без организации невозможно
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)

    # Предмет счёта: ровно один из трёх, иначе до ручки тело не дошло бы (422).
    tariff: Tariff | None = None
    solution: Solution | None = None
    # Сколько мест докуплено: заполнено только у счёта за места.
    quantity: int | None = None
    item_kind: str
    if payload.tariff_id is not None:
        item_kind = TARIFF_ITEM_KIND
        # Свободных слотов нет — продлевать некуда, и тариф в счёте неважен.
        if free_slot(organization) is None:
            raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_ALREADY_BOUGHT_DETAIL)
        tariff = db.get(Tariff, payload.tariff_id)
        if tariff is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, TARIFF_NOT_FOUND_DETAIL)
    elif payload.solution_id is not None:
        # К решению запрет «тариф уже выбран» не применяется: тариф держит
        # кабинет живым, а решение — отдельное право, и они не исключают друг
        # друга. Скрытая строка каталога списком не продаётся, но по `id`
        # покупается — как у тарифов.
        item_kind = SOLUTION_ITEM_KIND
        solution = db.get(Solution, payload.solution_id)
        if solution is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, SOLUTION_NOT_FOUND_DETAIL)
        # Строка «Дополнительные сотрудники» — не решение, а предмет счёта
        # `seats`: у неё нет периода права, и оплата решения завела бы право на
        # код `extra_member`, которое не читает ни одна ручка (`app/seats.py`
        # считает места, а не права), то есть человек заплатил бы 900 ₽ и не
        # получил ничего. Строку нельзя просто спрятать (`is_visible = false`):
        # её показывает карточка магазина, поэтому закрыт именно этот путь
        # покупки. Ответ — `404` как у несуществующего решения: подтверждать
        # существование непродаваемой строки незачем, а мест это не касается —
        # они покупаются полем `seats`.
        if solution.code == EXTRA_MEMBER_CODE:
            raise HTTPException(status.HTTP_404_NOT_FOUND, SOLUTION_NOT_FOUND_DETAIL)
    else:
        # Места: тело без предмета сюда не дошло бы (422), `seats` уже проверен
        # схемой на 1…100 — остались проверки состояния организации.
        assert payload.seats is not None  # Схема гарантирует: предмет ровно один.
        item_kind = SEATS_ITEM_KIND
        quantity = payload.seats
        state = organization_subscription(db, organization)
        # Порядок отказов — часть контракта: без тарифа «докупить» нечего,
        # на безлимите предел не нужен вовсе, и только потом «не продаётся».
        if state.tariff is None:
            raise HTTPException(status.HTTP_409_CONFLICT, SEATS_REQUIRE_TARIFF_DETAIL)
        if state.tariff.max_members is None:
            raise HTTPException(status.HTTP_409_CONFLICT, SEATS_UNLIMITED_TARIFF_DETAIL)
        solution = catalog_row(db)
        if solution is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, SEATS_NOT_FOR_SALE_DETAIL)

    if not organization.name or not organization.inn:
        raise HTTPException(status.HTTP_409_CONFLICT, BUYER_REQUISITES_DETAIL)

    # Дедупликация — по предмету, а не «любой живой счёт организации»: иначе счёт
    # за тариф блокировал бы покупку решения и наоборот. У мест предмет включает
    # количество: два клика с разным количеством — два счёта осознанно. Список, а
    # не кортеж: условия одного смысла, и их набор у видов разный.
    same_item: list[ColumnElement[bool]]
    if tariff is not None:
        same_item = [Invoice.tariff_id == tariff.id, Invoice.solution_id.is_(None)]
    elif quantity is not None:
        assert solution is not None  # Предмет проверен выше: до сюда без него не дойти.
        same_item = [Invoice.solution_id == solution.id, Invoice.quantity == quantity]
    else:
        assert solution is not None  # Предмет проверен выше: до сюда без него не дойти.
        same_item = [Invoice.solution_id == solution.id, Invoice.tariff_id.is_(None)]
    existing = db.scalar(
        select(Invoice)
        .where(
            Invoice.organization_id == organization.id,
            Invoice.status == NEW_STATUS,
            Invoice.item_kind == item_kind,
            *same_item,
        )
        .order_by(Invoice.id.desc())
    )
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        # Человек только что нажал «Купить» с отметкой, а счёт за этот тариф уже
        # висит неоплаченным: дописываем пустой акцепт, но не перезаписываем
        # записанный — иначе прежняя дата согласия поехала бы на каждом клике.
        # У счёта за решение и за места отметки нет, и его акцепт остаётся `NULL`.
        if tariff is not None and not has_acceptance(existing):
            record_acceptance(db, existing, user)
            db.commit()
            db.refresh(existing)
        return _one_response(db, existing, membership)

    item = tariff if tariff is not None else solution
    assert item is not None  # Предмет проверен выше: до сюда без него не дойти.
    invoice = Invoice(
        organization_id=organization.id,
        item_kind=item_kind,
        tariff_id=tariff.id if tariff is not None else None,
        solution_id=solution.id if solution is not None else None,
        # Количество есть только у счёта за места: у тарифа и решения оно
        # неприменимо, и `NULL` — честное «не про количество».
        quantity=quantity,
        # Номер `СЧ-<год>-<id>` требует `id`, поэтому строка сначала сохраняется
        # с временным номером и получает окончательный в том же коммите.
        number=pending_invoice_number(),
        status=NEW_STATUS,
        # Сумму считает сервер: у мест это цена места × количество, у остальных
        # видов — цена строки прайса или каталога.
        amount=item.amount * quantity if quantity is not None else item.amount,
        currency=item.currency,
        # Снимок покупателя и предмета на момент покупки.
        buyer_name=organization.name,
        buyer_inn=organization.inn,
        buyer_kpp=organization.kpp,
        buyer_ogrn=organization.ogrn,
        buyer_address=organization.address,
        tariff_name=item.name,
        tariff_period=item.period,
    )
    db.add(invoice)
    db.flush()
    # Отметка оферты для тарифа обязательна по схеме, поэтому сюда без неё не
    # дойти; у счёта за решение акцепта нет, и `offer_*` остаются `NULL`.
    if tariff is not None:
        record_acceptance(db, invoice, user)
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
    acts = act_invoice_ids(db, [invoice.id for invoice in invoices])
    can_manage = membership.role in EDIT_ROLES
    return [invoice_response(invoice, invoice.id in acts, can_manage) for invoice in invoices]


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
            "content": {PDF_MEDIA_TYPE: {}},
            "description": "Печатная форма счёта отдельным файлом",
        },
    },
)
def download_invoice(invoice_id: int, membership: Membership, db: DbSession) -> Response:
    """Счёт на скачивание. Доступ как у чтения: любой участник организации.

    Байты берутся из файлового хранилища (`app/invoice_files.py`): форма
    собирается один раз, при первом скачивании, и дальше отдаётся сохранённая.
    Контракт ручки не меняется — код, тип и имя файла прежние.
    """
    invoice = _load_own_invoice(db, membership, invoice_id)
    content = invoice_files.read_or_store(db, invoice, invoice_files.INVOICE_PURPOSE)
    return pdf_response(content, f"invoice-{invoice.number}.pdf")


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
            "content": {PDF_MEDIA_TYPE: {}},
            "description": "Печатная форма акта отдельным файлом",
        },
    },
)
def download_act(invoice_id: int, membership: Membership, db: DbSession) -> Response:
    """Акт на скачивание. До оплаты акта нет — `404`.

    Как и у счёта, байты приходят из хранилища: акт оплаты собирается один раз и
    дальше отдаётся сохранённое. Проверка «акт уже есть» остаётся здесь и
    отвечает `404` до первой оплаты — файл она не создаёт.
    """
    invoice = _load_own_invoice(db, membership, invoice_id)
    if invoice.id not in act_invoice_ids(db, [invoice.id]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, ACT_NOT_FOUND_DETAIL)
    content = invoice_files.read_or_store(db, invoice, invoice_files.ACT_PURPOSE)
    return pdf_response(content, f"act-{invoice.number}.pdf")
