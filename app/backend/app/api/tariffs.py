"""Публичный прайс и тариф организации.

`GET /api/tariffs` открыт анониму, как `GET /api/health`: страница `/pricing`
доступна без сессии. Ручка отдаёт только опубликованные тарифы
(`is_visible = true`) и не умеет показать скрытые ни при каких параметрах — этого
не позволяет сам запрос, а не проверка после выборки.

`/current` — подписка самой организации, а не прайс: его читает любой участник
(роль не важна, это свои данные). Ответ описывает действующий тариф и его конец,
остаток дней, признак скорого конца и оплаченный вперёд период — всё это считает
`app/subscription.py`. Правки здесь нет: тариф привязывается при покупке или
администратором платформы, поэтому кабинет только показывает назначенное и не
может его сменить. Коды отказа у чтения: 401 без сессии, 403 без активированного
кабинета, 404 без членства в организации.

Скрытый тариф (`is_visible = false`) не продаётся и в прайс не попадает, но у
организации, которой он уже назначен, остаётся видимым: `is_visible` отсекает
только публичный список, а не привязку.

`/extra-seats` — параметры докупки мест для той же публичной страницы (#177):
цена места без скидки, потолок продажи и шесть ступеней скидки за каждый полный
десяток. Ручка тоже открыта анониму, потому что `/pricing` рисует таблицу
ступеней до входа, а `unit_amount` каждой ступени считает сервер
(`app/seats.py`) — экран показывает готовые числа и скидку сам не выводит. `404`
означает, что строки каталога `extra_member` нет или она скрыта: дополнительные
сотрудники не продаются.
"""

from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.organization import ORGANIZATION_NOT_FOUND_DETAIL, Membership
from app.db import get_db
from app.models.tariff import Tariff
from app.pricing import format_price
from app.schemas.tariff import (
    ExtraSeatsResponse,
    NextTariffResponse,
    OrganizationTariffResponse,
    SeatBandResponse,
    TariffPeriod,
    TariffResponse,
)
from app.schemas.user import ErrorResponse
from app.seats import (
    MAX_SEATS_PER_PURCHASE,
    SEAT_BANDS,
    SEATS_NOT_FOR_SALE_DETAIL,
    catalog_row,
    unit_amount,
)
from app.subscription import subscription_state

router = APIRouter(prefix="/tariffs", tags=["tariffs"])
DbSession = Annotated[Session, Depends(get_db)]

# Ответы чтения тарифа организации: 403 здесь — неактивированный кабинет.
CURRENT_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": "Требуется авторизация",
    },
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": "Кабинет не активирован",
    },
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ORGANIZATION_NOT_FOUND_DETAIL,
    },
}


def tariff_response(tariff: Tariff) -> TariffResponse:
    """Ответ по строке тарифа: `price_label` считает сервер, клиент его не собирает.

    Функция публичная, а не приватная: форму ответа собирает и платформенный
    контур (`app/api/platform_tariffs.py`), а вторая копия этой сборки разошлась
    бы с первой на первой же правке формулы цены.
    """
    return TariffResponse(
        id=tariff.id,
        name=tariff.name,
        description=tariff.description,
        amount=tariff.amount,
        currency=tariff.currency,
        unit_label=tariff.unit_label,
        position=tariff.position,
        is_visible=tariff.is_visible,
        max_members=tariff.max_members,
        tooltip=tariff.tooltip,
        group_code=tariff.group_code,
        # В колонке `VARCHAR(10)` набор значений держит `CHECK` по тем же
        # периодам, что перечисляет `TariffPeriod`; приведение говорит об этом
        # типизатору, а не ослабляет проверку.
        period=cast(TariffPeriod, tariff.period),
        price_label=format_price(tariff.amount, tariff.currency, tariff.period, tariff.unit_label),
    )


@router.get("", response_model=list[TariffResponse], summary="Опубликованные тарифы")
def list_tariffs(db: DbSession) -> list[TariffResponse]:
    """Прайс для страницы `/pricing`: только видимые тарифы и без авторизации."""
    visible = db.scalars(
        select(Tariff).where(Tariff.is_visible.is_(True)).order_by(Tariff.position, Tariff.id)
    )
    return [tariff_response(tariff) for tariff in visible]


# 404 у параметров мест один: строки каталога, по которой продаются места, нет
# или она скрыта — это одно и то же состояние «не продаются».
EXTRA_SEATS_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": SEATS_NOT_FOR_SALE_DETAIL,
    }
}


@router.get(
    "/extra-seats",
    response_model=ExtraSeatsResponse,
    summary="Параметры докупки дополнительных мест",
    responses=EXTRA_SEATS_RESPONSES,
)
def read_extra_seats(db: DbSession) -> ExtraSeatsResponse:
    """Ступени скидки за места: открыто анониму, как сам прайс.

    Экран `/pricing` показывает таблицу ступеней и цену места, но скидку сам не
    выводит: ступени приходят готовыми, с посчитанным `unit_amount`, и сумма
    заказа сходится с суммой счёта на сервере.

    `404` — строки каталога нет или она скрыта: дополнительные сотрудники не
    продаются, и показывать ступени нечего.
    """
    line = catalog_row(db)
    if line is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, SEATS_NOT_FOR_SALE_DETAIL)
    return ExtraSeatsResponse(
        base_amount=line.amount,
        currency=line.currency,
        max_quantity=MAX_SEATS_PER_PURCHASE,
        bands=[
            SeatBandResponse(
                start=band.start,
                # Последняя ступень открыта вверх, но продаётся не больше
                # `MAX_SEATS_PER_PURCHASE`: ответ не обещает того, чего нет.
                to=band.end if band.end is not None else MAX_SEATS_PER_PURCHASE,
                discount_percent=band.discount_percent,
                unit_amount=unit_amount(line.amount, band.start),
            )
            for band in SEAT_BANDS
        ],
    )


@router.get(
    "/current",
    response_model=OrganizationTariffResponse,
    summary="Тариф организации",
    responses=CURRENT_RESPONSES,
)
def read_organization_tariff(membership: Membership, db: DbSession) -> OrganizationTariffResponse:
    """Подписка организации: действующий тариф, его конец и оплаченное вперёд.

    Читает любой участник, роль не важна. Ручка только на чтение: сменить тариф
    из кабинета нельзя, привязка появляется при покупке или администратором
    платформы. Истёкший текущий период и наступивший будущий — вычисление, а не
    запись: ручка ничего не мутирует и воркера не требует.
    """
    state = subscription_state(db, membership.organization_id)
    next_period = (
        NextTariffResponse(
            tariff=tariff_response(state.next_tariff), starts_at=state.next_starts_at
        )
        if state.next_tariff is not None and state.next_starts_at is not None
        else None
    )
    return OrganizationTariffResponse(
        tariff=tariff_response(state.tariff) if state.tariff is not None else None,
        ends_at=state.ends_at,
        days_left=state.days_left,
        is_expiring=state.is_expiring,
        next=next_period,
        # Предел и разбивку считает `app/subscription.py`: кабинет показывает
        # готовые числа и не складывает места сам.
        member_limit=state.member_limit,
        extra_seats=state.extra_seats,
    )
