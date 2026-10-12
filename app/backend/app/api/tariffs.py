"""Публичный прайс и тариф организации.

`GET /api/tariffs` открыт анониму, как `GET /api/health`: страница `/pricing`
доступна без сессии. Ручка отдаёт только опубликованные тарифы
(`is_visible = true`) и не умеет показать скрытые ни при каких параметрах — этого
не позволяет сам запрос, а не проверка после выборки.

`/current` — тариф самой организации, а не прайс: его читает любой участник
(роль не важна, это свои данные). Правки здесь нет: тариф привязывается при
покупке или администратором платформы, поэтому кабинет только показывает
назначенное и не может его сменить. Коды отказа у чтения: 401 без сессии, 403
без активированного кабинета, 404 без членства в организации.

Скрытый тариф (`is_visible = false`) не продаётся и в прайс не попадает, но у
организации, которой он уже назначен, остаётся видимым: `is_visible` отсекает
только публичный список, а не привязку.
"""

from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.organization import ORGANIZATION_NOT_FOUND_DETAIL, Membership
from app.db import get_db
from app.models.organization import Organization
from app.models.tariff import Tariff
from app.pricing import format_price
from app.schemas.tariff import OrganizationTariffResponse, TariffPeriod, TariffResponse
from app.schemas.user import ErrorResponse

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
        # В колонке `VARCHAR(10)` набор значений держит `CHECK` по тем же трём
        # периодам, что перечисляет `TariffPeriod`; приведение говорит об этом
        # типизатору, а не ослабляет проверку.
        period=cast(TariffPeriod, tariff.period),
        price_label=format_price(tariff.amount, tariff.currency, tariff.period, tariff.unit_label),
    )


def _load_organization(db: Session, organization_id: int) -> Organization:
    organization = db.get(Organization, organization_id)
    if organization is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)
    return organization


def _organization_tariff(organization: Organization, db: Session) -> OrganizationTariffResponse:
    """Собрать ответ по тарифу организации: `None` — тариф ещё не назначен."""
    if organization.tariff_id is None:
        return OrganizationTariffResponse(tariff=None)
    tariff = db.get(Tariff, organization.tariff_id)
    if tariff is None:
        # Внешний ключ с `ON DELETE SET NULL` такого не допускает: ссылка на
        # удалённый тариф обнуляется вместе с удалением. Ответ без тарифа лучше
        # падения экрана, если строка всё же разошлась.
        return OrganizationTariffResponse(tariff=None)
    return OrganizationTariffResponse(tariff=_response(tariff))


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
    """Купленный организацией тариф. Читает любой участник, роль не важна.

    Ручка только на чтение: сменить тариф из кабинета нельзя, привязка появляется
    при покупке или администратором платформы.
    """
    organization = _load_organization(db, membership.organization_id)
    return _organization_tariff(organization, db)
