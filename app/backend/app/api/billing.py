"""Счета организации: покупка тарифа, решения или мест, статусы и печатные формы.

Роутер закрытого кабинета, но **не** рабочих разделов: на закрытом пробном
периоде покупка обязана работать (ради неё кабинет и открывается), поэтому
вместо `SubscribedUser` здесь стоит `ActiveUser`. Правка статуса и покупка
требуют роли с правом редактирования (`EditableMembership`), чтение счетов и
скачивание файлов — любого участия в организации (`Membership`).

Предмет счёта бывает трёх видов: тариф (`item_kind = 'tariff'`), решение
магазина улучшений (`item_kind = 'solution'`) и докупленные сверх тарифа места
(`item_kind = 'seats'`). Но **позиций в счёте может быть несколько**: покупка
«тариф + места» — это одна сделка и один документ с двумя строками
`invoice_items` (#177). Поэтому вид выбирает не «ровно одно поле тела», а состав
запроса: `tariff_id` — тариф, `tariff_id` вместе с `seats` — тариф и места,
`seats` без тарифа — докупка к живому тарифу, `solution_id` — отдельный счёт.
Решение несовместимо с остальными полями: у него своё право и свой срок.
Снимок предмета первой позиции лежит в `tariff_name`/`tariff_period`, полный
состав отдаёт ответ (`items`) и печатает документ.

Места — не строка каталога решений с количеством: в теле едет количество, а
цену, сумму и предмет счёта считает сервер по строке каталога `extra_member`
(`app/seats.py`). Клиент не присылает деньги и не собирает сумму сам, и скидку
ступени тоже не выводит: её считает `seats_total`.

Коды отказа выбраны так, чтобы не подтверждать существование чужих данных:
чужой счёт отвечает `404`, а не `403`. `403` остаётся за неактивированным
кабинетом и ролью без права правки.

Счета живут отдельно от публичной таблицы `documents`: та отдаётся анониму, а
счёт — приватный документ организации.
"""

from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
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
    InvoiceItem,
    invoice_number,
    pending_invoice_number,
    subject_items,
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
    seats_total,
    unit_amount,
)
from app.security import ACTIVATION_REQUIRED_DETAIL, ActiveUser
from app.solutions import (
    SOLUTION_ALREADY_OWNED_DETAIL,
    SOLUTION_REQUIRE_TARIFF_DETAIL,
    owned_codes,
)
from app.subscription import (
    ONCE_PERIOD,
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
            f"{SEATS_REQUIRE_TARIFF_DETAIL}; {SEATS_UNLIMITED_TARIFF_DETAIL}; "
            f"{SOLUTION_REQUIRE_TARIFF_DETAIL}; {SOLUTION_ALREADY_OWNED_DETAIL}"
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


def _position_key(kind: str, reference_id: int | None, quantity: int | None) -> str:
    """Ключ позиции для дедупликации: вид, строка каталога и количество.

    Строкой, а не кортежем: у мест количество — часть предмета, а у тарифа и
    решения его нет, и сравнивать `None` с числом через сортировку нельзя.
    """
    return f"{kind}:{reference_id if reference_id is not None else ''}:" + (
        f"{quantity if quantity is not None else ''}"
    )


def _invoice_key(invoice: Invoice) -> tuple[str, ...]:
    """Набор предметов счёта. Сравнивается как множество, а не по порядку строк."""
    return tuple(
        sorted(
            _position_key(
                item.kind,
                item.tariff_id if item.kind == TARIFF_ITEM_KIND else item.solution_id,
                item.quantity,
            )
            for item in subject_items(invoice)
        )
    )


def _live_invoice_for(db: Session, organization_id: int, wanted: tuple[str, ...]) -> Invoice | None:
    """Живой неоплаченный счёт за **тот же набор** предметов, если он есть.

    Сравнивается состав, а не «вид предмета»: у покупки «тариф + пять мест» и
    «тариф + десять мест» один и тот же тариф, но это разные сделки. Счетов без
    позиций (выставленных до ревизии `0066_invoice_items`) это тоже касается:
    `subject_items` собирает их позицию из снимка счёта.
    """
    candidates = db.scalars(
        select(Invoice)
        .where(
            Invoice.organization_id == organization_id,
            Invoice.status == NEW_STATUS,
        )
        .order_by(Invoice.id.desc())
    )
    for invoice in candidates:
        if _invoice_key(invoice) == wanted:
            return invoice
    return None


def _tariff_position(tariff: Tariff, position: int) -> InvoiceItem:
    """Позиция тарифа: количество неприменимо, цена позиции — цена строки прайса."""
    return InvoiceItem(
        position=position,
        kind=TARIFF_ITEM_KIND,
        name=tariff.name,
        period=tariff.period,
        quantity=None,
        unit_amount=tariff.amount,
        amount=tariff.amount,
        tariff_id=tariff.id,
    )


def _seats_position(line: Solution, quantity: int, position: int) -> InvoiceItem:
    """Позиция мест: цена места со скидкой ступени и сумма на весь набор.

    `unit_amount × quantity = amount` сходится до копейки: округляется цена
    места, а не произведение (`app/seats.py`).
    """
    return InvoiceItem(
        position=position,
        kind=SEATS_ITEM_KIND,
        name=line.name,
        period=line.period,
        quantity=quantity,
        unit_amount=unit_amount(line.amount, quantity),
        amount=seats_total(line.amount, quantity),
        solution_id=line.id,
    )


def _solution_position(solution: Solution, position: int) -> InvoiceItem:
    """Позиция решения магазина: количество неприменимо, цена — цена каталога.

    Период снимка — `once`, а не `solutions.period`: своего срока у решения больше
    нет, и печатная форма читает ту же строку, что каталог («500 ₽ разово»).
    """
    return InvoiceItem(
        position=position,
        kind=SOLUTION_ITEM_KIND,
        name=solution.name,
        period=ONCE_PERIOD,
        quantity=None,
        unit_amount=solution.amount,
        amount=solution.amount,
        solution_id=solution.id,
    )


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

    **Покупка «тариф + места» — одна сделка и один счёт.** Тело с `tariff_id` и
    `seats` не создаёт второй документ: у счёта две позиции, и сумму
    (`тариф + места`) считает сервер. Отказ «тариф уже оплачен» касается только
    тарифной части: докупить места к живому тарифу отдельным запросом `{ "seats":
    N }` по-прежнему можно, и это один счёт с одной позицией.

    **Места покупаются только сверх тарифа с пределом мест.** Порядок отказов
    важен и дословен: нет действующего тарифа (запрос без `tariff_id`) — `409
    SEATS_REQUIRE_TARIFF_DETAIL` (докупать нечего, сначала тариф); тариф
    безлимитный — `409 SEATS_UNLIMITED_TARIFF_DETAIL` (предела нет, место ничего
    не добавляет); строки каталога нет или она скрыта — `404
    SEATS_NOT_FOR_SALE_DETAIL`. Сумма считается здесь: цена места со скидкой
    ступени × количество (`app/seats.py::seats_total`), и скидка действует на
    весь набор мест. За места оферта не требуется — это не подписка, а доплата к
    уже оплаченной.

    **Строка мест не покупается как решение.** Она видима в каталоге (`is_visible
    = true`) — по ней магазин рисует карточку, — поэтому путь `{ "solution_id":
    <её id> }` открыт и его надо закрыть: иначе оплата завела бы право на код
    `extra_member`, которого не читает ни одна ручка, а счётчик мест не вырос бы.
    Такой `solution_id` получает `404 SOLUTION_NOT_FOUND_DETAIL` — как
    несуществующее решение; места же покупаются полем `seats`.

    **Решение покупается только к действующему тарифу, и только один раз.**
    У права на решение больше нет своего срока (`app.solutions`): оно действует,
    пока действует тариф, поэтому покупка без тарифа отвечает `409
    SOLUTION_REQUIRE_TARIFF_DETAIL`, а повторная покупка уже подключённого —
    `409 SOLUTION_ALREADY_OWNED_DETAIL`: второй счёт ничего бы не добавил.
    Порядок этих двух отказов — часть контракта: при мёртвом тарифе помеха именно
    тариф, и человеку не говорят «уже подключено» о том, что не работает.

    Повторное нажатие не плодит счета: живой неоплаченный счёт **за тот же набор
    предметов** возвращается как `200` с тем же телом, а новый не создаётся. Набор
    сравнивается целиком, а не по виду предмета: «тариф + 5 мест» и «тариф + 10
    мест» — разные сделки, а «тариф» и «решение» друг другу не мешают. Строка
    организации берётся под блокировку, иначе два одновременных клика прошли бы
    проверку вместе.

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

    # Состав сделки. `seats` — не отдельный предмет, а количество мест: оно может
    # ехать вместе с тарифом и тогда у счёта две позиции. Решение с другими
    # полями несовместимо — это отсекает схема, до ручки такое тело не доходит.
    tariff: Tariff | None = None
    solution: Solution | None = None
    # Строка каталога, по которой продаются места: `None` — места не покупаются.
    seats_line: Solution | None = None
    quantity: int | None = None
    positions: list[InvoiceItem] = []
    item_kind: str

    if payload.solution_id is not None:
        # К решению запрет «тариф уже выбран» не применяется: тариф держит
        # кабинет живым, а решение — отдельное право, и они не исключают друг
        # друга. Скрытая строка каталога списком не продаётся, но по `id`
        # покупается — как у тарифов.
        solution = db.get(Solution, payload.solution_id)
        if solution is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, SOLUTION_NOT_FOUND_DETAIL)
        # Строка «Дополнительные сотрудники» — не решение, а предмет счёта
        # `seats`: у неё нет периода права, и оплата решения завела бы право на
        # код `extra_member`, которое не читает ни одна ручка (`app/seats.py`
        # считает места, а не права), то есть человек заплатил бы и не получил
        # ничего. Строку нельзя просто спрятать (`is_visible = false`): её
        # показывает карточка магазина, поэтому закрыт именно этот путь покупки.
        # Ответ — `404` как у несуществующего решения: подтверждать
        # существование непродаваемой строки незачем, а мест это не касается —
        # они покупаются полем `seats`.
        if solution.code == EXTRA_MEMBER_CODE:
            raise HTTPException(status.HTTP_404_NOT_FOUND, SOLUTION_NOT_FOUND_DETAIL)
        # Решение продаётся только к действующему тарифу: своего срока у права
        # больше нет, и купленное на пробном периоде решение не открыло бы
        # ничего — человек заплатил бы впустую. Порядок отказов — часть
        # контракта: при мёртвом тарифе помеха именно тариф, а не «уже
        # подключено».
        if not organization_subscription(db, organization).is_active:
            raise HTTPException(status.HTTP_409_CONFLICT, SOLUTION_REQUIRE_TARIFF_DETAIL)
        # Право действует весь оплаченный тариф, поэтому вторая покупка ничего не
        # добавляла бы, а второй счёт был бы тихой двойной продажей.
        if solution.code in owned_codes(db, organization.id):
            raise HTTPException(status.HTTP_409_CONFLICT, SOLUTION_ALREADY_OWNED_DETAIL)
        item_kind = SOLUTION_ITEM_KIND
        positions = [_solution_position(solution, 1)]
    else:
        if payload.tariff_id is not None:
            # Свободных слотов нет — продлевать некуда, и тариф в счёте неважен.
            if free_slot(organization) is None:
                raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_ALREADY_BOUGHT_DETAIL)
            tariff = db.get(Tariff, payload.tariff_id)
            if tariff is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, TARIFF_NOT_FOUND_DETAIL)
        if payload.seats is not None:
            # Схема уже проверила 1…100; здесь — состояние организации и
            # каталога. Порядок отказов — часть контракта: без тарифа «докупить»
            # нечего, на безлимите предел не нужен вовсе, и только потом «не
            # продаётся». Проверяется тариф, к которому места докупаются: у
            # покупки «тариф + места» это покупаемый тариф, у докупки — живой.
            quantity = payload.seats
            live = tariff
            if live is None:
                state = organization_subscription(db, organization)
                if state.tariff is None:
                    raise HTTPException(status.HTTP_409_CONFLICT, SEATS_REQUIRE_TARIFF_DETAIL)
                live = state.tariff
            if live.max_members is None:
                raise HTTPException(status.HTTP_409_CONFLICT, SEATS_UNLIMITED_TARIFF_DETAIL)
            seats_line = catalog_row(db)
            if seats_line is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, SEATS_NOT_FOR_SALE_DETAIL)
        # Тариф идёт первой позицией: по нему заполняются `item_kind`,
        # `tariff_name` и `tariff_period` — снимок счёта остаётся тарифным, как у
        # прежних счетов, а места читаются из `items`.
        if tariff is not None:
            positions.append(_tariff_position(tariff, len(positions) + 1))
        if seats_line is not None and quantity is not None:
            positions.append(_seats_position(seats_line, quantity, len(positions) + 1))
        item_kind = TARIFF_ITEM_KIND if tariff is not None else SEATS_ITEM_KIND

    if not organization.name or not organization.inn:
        raise HTTPException(status.HTTP_409_CONFLICT, BUYER_REQUISITES_DETAIL)

    # Дедупликация — по набору предметов, а не «любой живой счёт организации»:
    # иначе счёт за тариф блокировал бы покупку решения и наоборот, а «тариф + 5
    # мест» совпал бы с «тариф + 10 мест». Один и тот же набор, нажатый дважды,
    # возвращает тот же счёт.
    wanted = tuple(
        sorted(
            _position_key(
                position.kind,
                position.tariff_id if position.kind == TARIFF_ITEM_KIND else position.solution_id,
                position.quantity,
            )
            for position in positions
        )
    )
    existing = _live_invoice_for(db, organization.id, wanted)
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

    first = positions[0]
    source = tariff if tariff is not None else (solution if solution is not None else seats_line)
    assert source is not None  # Схема гарантирует, что предмет выбран.
    invoice = Invoice(
        organization_id=organization.id,
        item_kind=item_kind,
        tariff_id=tariff.id if tariff is not None else None,
        solution_id=solution.id if solution is not None else None,
        # Количество есть только у счёта, выставленного за одни места: в счёте
        # «тариф + места» состав покупки отдаёт `items`, а не эта колонка.
        quantity=quantity if item_kind == SEATS_ITEM_KIND else None,
        # Номер `СЧ-<год>-<id>` требует `id`, поэтому строка сначала сохраняется
        # с временным номером и получает окончательный в том же коммите.
        number=pending_invoice_number(),
        status=NEW_STATUS,
        # Сумму считает сервер, и она равна сумме позиций: у мест — цена места со
        # скидкой ступени × количество, у тарифа и решения — цена их строки.
        amount=sum((position.amount for position in positions), Decimal("0.00")),
        currency=source.currency,
        # Снимок покупателя и предмета первой позиции на момент покупки.
        buyer_name=organization.name,
        buyer_inn=organization.inn,
        buyer_kpp=organization.kpp,
        buyer_ogrn=organization.ogrn,
        buyer_address=organization.address,
        tariff_name=first.name,
        tariff_period=first.period,
        # Позиции сохраняются вместе со счётом: каскад `all, delete-orphan`
        # пишет их в ту же транзакцию, что и саму строку счёта.
        items=positions,
    )
    db.add(invoice)
    db.flush()
    # Отметка оферты для тарифа обязательна по схеме, поэтому сюда без неё не
    # дойти; у счёта за решение и за одни места акцепта нет, и `offer_*` пусты.
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
