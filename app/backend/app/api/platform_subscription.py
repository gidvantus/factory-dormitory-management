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

**Что здесь пишется.** Только сроки: `tariff_ends_at` (правка срока и снятие
тарифа) и `organization_solutions.expires_at` (снятие расширения). Ничего не
удаляется и не обнуляется — «не действует» в проекте это срок в прошлом, а не
флаг. Оплаченный вперёд слот не меняется ни одним из действий.

**Тексты отказов — контракт.** `404 «Организация не найдена»` приходит из
`load_organization` (тот же текст, что во всём API), `404 «Расширение не найдено»`
и тексты валидатора схемы объявлены здесь и в
`app/schemas/platform_subscription.py`. Кабинет передаёт их дословно, а фронтенд
показывает в `role="alert"`.
"""

from datetime import UTC, date, datetime
from typing import Annotated, cast

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

READ_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ORGANIZATION_NOT_FOUND_DETAIL,
    },
}

UPDATE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ORGANIZATION_NOT_FOUND_DETAIL,
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": f"{PAID_UNTIL_FORMAT_MESSAGE}, лишнее поле или тело не по схеме",
    },
}

DEACTIVATE_SUBSCRIPTION_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ORGANIZATION_NOT_FOUND_DETAIL,
    },
}

DEACTIVATE_SOLUTION_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": f"{ORGANIZATION_NOT_FOUND_DETAIL}; {SOLUTION_NOT_FOUND_DETAIL}",
    },
}


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

    Читаются оба слота и все права — одним местом на все четыре ручки: ответ после
    действия обязан быть тем же объектом, что и ответ чтения, иначе фронтенд
    показывал бы после действия другую форму данных.
    """
    moment = now or datetime.now(UTC)
    current = current_slot(db, organization)
    upcoming = next_slot(db, organization)

    current_tariff = _tariff_block(current.tariff, current.ends_at, moment)
    upcoming_tariff = _tariff_block(upcoming.tariff, upcoming.ends_at, moment)

    # Докупленные места не зависят от слотов: платили за них отдельно, и правка
    # срока их не сбрасывает.
    extra_seats = organization.extra_seats or 0
    member_limit = (
        current.tariff.max_members + extra_seats
        if current.tariff is not None and current.tariff.max_members is not None
        else None
    )

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
        extra_seats=extra_seats,
        member_limit=member_limit,
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
    """
    organization = load_organization(db, organization_id)
    # Валидатор схемы не пропустит `None`: пришедшая дата — всегда дата.
    set_current_end(organization, cast(date, payload.paid_until))
    db.commit()
    db.refresh(organization)
    return _state(db, organization)


@router.post(
    "/{organization_id}/subscription/deactivate",
    response_model=OrganizationSubscriptionResponse,
    summary="Снять активность тарифа организации",
    responses=DEACTIVATE_SUBSCRIPTION_RESPONSES,
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

    `next_*` не меняются. Если оплаченный вперёд слот есть, после снятия текущего
    действующим станет он — это правило слотов, а не побочный эффект команды.
    """
    organization = load_organization(db, organization_id)
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
