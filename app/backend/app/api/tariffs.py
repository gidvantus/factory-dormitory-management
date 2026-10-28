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
"""

from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.organization import ORGANIZATION_NOT_FOUND_DETAIL, Membership
from app.db import get_db
from app.models.tariff import Tariff
from app.pricing import format_price
from app.schemas.tariff import (
    NextTariffResponse,
    OrganizationTariffResponse,
    TariffPeriod,
    TariffResponse,
)
from app.schemas.user import ErrorResponse
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


def _response(tariff: Tariff) -> TariffResponse:
    """Ответ по строке тарифа: `price_label` считает сервер, клиент его не собирает."""
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
    return [_response(tariff) for tariff in visible]


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
        NextTariffResponse(tariff=_response(state.next_tariff), starts_at=state.next_starts_at)
        if state.next_tariff is not None and state.next_starts_at is not None
        else None
    )
    return OrganizationTariffResponse(
        tariff=_response(state.tariff) if state.tariff is not None else None,
        ends_at=state.ends_at,
        days_left=state.days_left,
        is_expiring=state.is_expiring,
        next=next_period,
    )
