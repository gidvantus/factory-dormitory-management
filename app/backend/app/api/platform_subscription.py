"""Тариф и расширения организации в кабинете оператора (#189).

Платформенный контур: ручки открывает сервисный токен кабинета оператора
(`X-Operator-Token`), а не cookie основного кабинета. Зависимость стоит на
роутере целиком, поэтому новая ручка не может её забыть — как у организаций,
пользователей, счетов, тарифов и каталога решений.

**Четыре ручки — один ответ.** Чтение, правка срока и оба снятия активности
отвечают одним объектом состояния (`OrganizationSubscriptionResponse`): фронтенд
после действия показывает ответ и ничего не перезапрашивает. Поэтому обработчики
не собирают «дельту», а заново читают состояние тем же `_state`.

**Что здесь читается.** Текущий и оплаченный вперёд слоты читаются **по колонкам**
(`current_slot`, `next_slot`), без «виртуального переезда» наступившего будущего
периода: оператор видит запись, а не вычисление. Права организации читаются
целиком, включая истёкшие (`app.solutions.organization_rights`). Все сроки, дни и
признаки «действует» считают `app/subscription.py` и `app/pricing.py` — второй
формулы срока и цены здесь нет.

**Предел мест — исключение и намеренно не «по записи».** `member_limit` и
`extra_seats` берутся из `organization_subscription`: предел приглашений в
продукте считает **действующий** тариф, и оператор должен видеть то же число, что
проверка приглашений и клиентский `GET /api/tariffs/current`. Своя арифметика по
записанному слоту дала бы устаревшее число, когда текущий слот истёк, а следующий
оплачен.

**Что здесь пишется.** Только сроки: `tariff_ends_at` (правка срока и снятие
тарифа) и `organization_solutions.expires_at` (снятие расширения). Ничего не
удаляется и не обнуляется — «не действует» в проекте это срок в прошлом, а не
флаг. Оплаченный вперёд слот не меняется ни одним из действий.

**Слот без строки тарифа — не запись, а отказ.** У новой организации
`tariff_id IS NULL` (тариф появляется оплатой счёта), поэтому правка срока и
снятие активности отвечают `409 «Тариф не назначен»`: записанный срок такого слота
не виден ни в ответе, ни в клиентском кабинете, а первая оплата его перезапишет.
Чтение при этом открыто — кадр «Тариф не назначен» макета рисуется по ответу `GET`.

**Тексты отказов — контракт.** `404 «Организация не найдена»` приходит из
`load_organization` (тот же текст, что во всём API), `404 «Расширение не найдено»`,
`409 «Тариф не назначен»` и тексты валидатора схемы объявлены здесь и в
`app/schemas/platform_subscription.py`. Кабинет передаёт их дословно, а фронтенд
показывает в `role="alert"`.
"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import solutions
from app.api.organization import ORGANIZATION_NOT_FOUND_DETAIL, load_organization
from app.db import get_db
from app.models.organization import Organization
from app.models.tariff import Tariff
from app.pricing import format_price
from app.schemas.platform_subscription import (
    PAID_UNTIL_FORMAT_MESSAGE,
    NextSubscription,
    OrganizationSubscriptionResponse,
    SubscriptionRight,
    SubscriptionTariff,
    UpdateSubscriptionRequest,
)
from app.schemas.user import ErrorResponse
from app.security import INVALID_OPERATOR_TOKEN_DETAIL, require_operator_service
from app.subscription import (
    current_slot,
    days_left,
    deactivate_current,
    is_live,
    next_slot,
    organization_subscription,
    paid_until,
    set_current_end,
)

# Зависимость на роутере целиком: ни одна ручка платформенного контура не
# открывается без сервисного токена.
router = APIRouter(
    prefix="/platform/organizations",
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

# Текст отказа по неизвестному коду расширения. Свой, а не «Организация не
# найдена»: оператор должен понимать, чего именно нет.
SOLUTION_NOT_FOUND_DETAIL = "Расширение не найдено"

# Отказ, когда в текущем слоте нет строки тарифа: менять срок и снимать
# активность нечего. Тем же словом это состояние называет макет
# (`mockups/189/notes.md`, кадр 6 — «Тариф не назначен»), поэтому второй текст
# для того же состояния не заводится: фронтенд покажет `detail` дословно.
TARIFF_NOT_ASSIGNED_DETAIL = "Тариф не назначен"

# Ответы раздела собираются друг из друга, а не копируются: у `404` общей
# организации, у `409` пустого слота и у `422` формата даты по одному описанию на
# весь раздел, и правка текста не может разойтись между ручками одного объекта.
READ_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ORGANIZATION_NOT_FOUND_DETAIL,
    },
}

# Запись в подписку: обе ручки (правка срока и снятие активности) отказывают
# одинаково, если менять нечего.
WRITE_RESPONSES: dict[int | str, dict[str, object]] = {
    **READ_RESPONSES,
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": TARIFF_NOT_ASSIGNED_DETAIL,
    },
}

UPDATE_RESPONSES: dict[int | str, dict[str, object]] = {
    **WRITE_RESPONSES,
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": f"{PAID_UNTIL_FORMAT_MESSAGE}, лишнее поле или тело не по схеме",
    },
}

DEACTIVATE_SOLUTION_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": f"{ORGANIZATION_NOT_FOUND_DETAIL}; {SOLUTION_NOT_FOUND_DETAIL}",
    },
}


def _require_tariff_slot(db: Session, organization: Organization) -> None:
    """Отказать `409`, если в текущем слоте нет строки тарифа.

    У только что зарегистрированной организации `tariff_id IS NULL`: тариф
    появляется оплатой счёта (`mockups/189/notes.md`, кадр 6). Срок в таком слоте
    был бы записью, которой не видно ни в ответе (`tariff: null`), ни в клиентском
    кабинете, — а первая же оплата его перезапишет. Поэтому правка срока и снятие
    активности на пустом слоте не «сохраняются молча», а отказывают.

    Тот же `409` получает слот, у которого строку прайса удалили
    (`ON DELETE SET NULL`): менять срок несуществующего тарифа нечего.
    """
    if current_slot(db, organization).tariff is None:
        raise HTTPException(status.HTTP_409_CONFLICT, TARIFF_NOT_ASSIGNED_DETAIL)


def _tariff_block(
    tariff: Tariff | None, ends_at: datetime | None, moment: datetime
) -> SubscriptionTariff | None:
    """Слот в ответ: строка прайса, срок и признаки.

    `None` — в слоте нет строки тарифа: либо он не оплачен, либо строку прайса
    удалили (`ON DELETE SET NULL`). Цену собирает `app.pricing.format_price` — та
    же функция, что у витрины и прайса, с тем же `unit_label`.
    """
    if tariff is None:
        return None
    return SubscriptionTariff(
        id=tariff.id,
        name=tariff.name,
        period=tariff.period,
        max_members=tariff.max_members,
        price_label=format_price(tariff.amount, tariff.currency, tariff.period, tariff.unit_label),
        ends_at=ends_at,
        paid_until=paid_until(ends_at),
        is_live=is_live(ends_at, moment),
    )


def _state(
    db: Session, organization: Organization, now: datetime | None = None
) -> OrganizationSubscriptionResponse:
    """Состояние подписки по уже прочитанной строке организации.

    Читаются оба слота, предел мест и все права — одним местом на все четыре ручки:
    ответ после действия обязан быть тем же объектом, что и ответ чтения, иначе
    фронтенд показывал бы после действия другую форму данных.

    Слоты — **запись** (`current_slot`, `next_slot`), а предел мест — **действие**
    (`organization_subscription`): приглашения считает действующий тариф, поэтому
    `member_limit` здесь тот же, что видит клиентский кабинет и проверка
    приглашений, а не арифметика по записанному слоту. Своей копии этой формулы
    нет: истёкший текущий слот и оплаченный следующий дали бы здесь устаревшее
    число.
    """
    moment = now or datetime.now(UTC)
    current = current_slot(db, organization)
    upcoming = next_slot(db, organization)

    current_tariff = _tariff_block(current.tariff, current.ends_at, moment)
    upcoming_tariff = _tariff_block(upcoming.tariff, upcoming.ends_at, moment)

    # Предел мест и докупленные места — из одного правила на весь продукт
    # (`app/subscription.py`): второй расчёт разошёлся бы с проверкой приглашений.
    active = organization_subscription(db, organization, moment)

    return OrganizationSubscriptionResponse(
        tariff=current_tariff,
        # Остатка нет у слота без тарифа: показывать «сколько дней у несуществующего
        # тарифа» нечего, а бессрочный и истёкший дают ноль самим правилом.
        days_left=0 if current.tariff is None else days_left(current.ends_at, moment),
        next=(
            NextSubscription(
                tariff=upcoming_tariff,
                ends_at=upcoming.ends_at,
                paid_until=paid_until(upcoming.ends_at),
            )
            if upcoming_tariff is not None
            else None
        ),
        extra_seats=active.extra_seats,
        member_limit=active.member_limit,
        solutions=[
            SubscriptionRight(
                code=right.code,
                name=right.name,
                expires_at=right.expires_at,
                paid_until=paid_until(right.expires_at),
                is_live=right.is_live,
            )
            for right in solutions.organization_rights(db, organization.id, moment)
        ],
    )


@router.get(
    "/{organization_id}/subscription",
    response_model=OrganizationSubscriptionResponse,
    summary="Тариф и расширения организации",
    responses=READ_RESPONSES,
)
def read_subscription(organization_id: int, db: DbSession) -> OrganizationSubscriptionResponse:
    """Записанные слоты подписки, остаток дней и все права на расширения.

    Читается именно запись: если срок текущего слота истёк, он так и показан
    (`is_live = false`), даже когда уже оплачен следующий. Права отдаются целиком,
    включая истёкшие: это единственное место, где видно историю покупок.
    Неизвестный `id` — общий `404` из `load_organization`.
    """
    return _state(db, load_organization(db, organization_id))


@router.patch(
    "/{organization_id}/subscription",
    response_model=OrganizationSubscriptionResponse,
    summary="Изменить срок действия тарифа организации",
    responses=UPDATE_RESPONSES,
)
def update_subscription(
    organization_id: int,
    payload: UpdateSubscriptionRequest,
    db: DbSession,
) -> OrganizationSubscriptionResponse:
    """Записать последний включённый день в текущий слот подписки.

    В базу ложится `paid_until 23:59:59.999999` по Москве (см.
    `app.subscription.set_current_end`), поэтому клиентский кабинет показывает ровно
    введённый день. Меняется только `tariff_ends_at`: `next_*` не трогаются,
    `tariff_id` остаётся на месте — так бессрочный тариф становится срочным, и
    обратной дороги (сделать срок бессрочным) из кабинета нет.

    Своих проверок значения здесь нет: формат даты проверяет схема, и её `422`
    с русским текстом уходит в кабинет дословно.

    Слота без строки тарифа это не касается: там правка не «сохраняется молча», а
    отказывает `409 «Тариф не назначен»` — записанный срок был бы невидим в ответе
    и в клиентском кабинете, а первая оплата его перезаписала бы.
    """
    organization = load_organization(db, organization_id)
    _require_tariff_slot(db, organization)
    set_current_end(organization, payload.paid_until)
    db.commit()
    db.refresh(organization)
    return _state(db, organization)


@router.post(
    "/{organization_id}/subscription/deactivate",
    response_model=OrganizationSubscriptionResponse,
    summary="Снять активность тарифа организации",
    responses=WRITE_RESPONSES,
)
def deactivate_subscription(
    organization_id: int,
    db: DbSession,
) -> OrganizationSubscriptionResponse:
    """Снять активность текущего тарифа: `tariff_ends_at` = момент вызова.

    Ничего не удаляется: «не действует» — это срок в прошлом, поэтому строки
    подписки, права и счета остаются на месте. Тела у команды нет: пустое тело и
    `{}` допустимы. Повторный вызов — тоже `200` и то же состояние «не действует»:
    клиент не должен различать «уже снят» и «снял только что».

    Слот без строки тарифа — `409 «Тариф не назначен»`: снимать активность нечего,
    и «уже не действует» не должно притворяться успешным действием.

    `next_*` не меняются. Если оплаченный вперёд слот есть, после снятия текущего
    действующим станет он — это правило слотов, а не побочный эффект команды.
    """
    organization = load_organization(db, organization_id)
    _require_tariff_slot(db, organization)
    deactivate_current(organization)
    db.commit()
    db.refresh(organization)
    return _state(db, organization)


@router.post(
    "/{organization_id}/solutions/{code}/deactivate",
    response_model=OrganizationSubscriptionResponse,
    summary="Снять активность расширения организации",
    responses=DEACTIVATE_SOLUTION_RESPONSES,
)
def deactivate_solution(
    organization_id: int,
    code: str,
    db: DbSession,
) -> OrganizationSubscriptionResponse:
    """Снять активность права организации на решение магазина.

    `expires_at` права становится моментом вызова; строка права остаётся и
    продолжает возвращаться из чтения с `is_live = false`, поэтому кабинет
    показывает «не действует», а платная функция у организации перестаёт
    работать (`app.solutions.has_solution`). Повторный вызов — тоже `200`.

    Неизвестный `code` — `404 «Расширение не найдено»`: у организации нет строки
    права на это решение, и «сняли нечего» отказом не притворяется.
    """
    organization = load_organization(db, organization_id)
    if solutions.deactivate_right(db, organization.id, code) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, SOLUTION_NOT_FOUND_DETAIL)
    db.commit()
    return _state(db, organization)
