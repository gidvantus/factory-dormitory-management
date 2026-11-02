"""Организации платформы: список и карточка для кабинета оператора.

Контур отдельный: ручки открывает сервисный токен кабинета оператора
(`X-Operator-Token`), а не cookie основного кабинета. Это сделано затем, чтобы
кабинет ничего не хранил: читает и правит он здесь, а источник правды,
правила и журнал остаются в основном приложении.

Что здесь осознанно **не** так, как в кабинете клиента:

* `organization_id` есть в пути и в ответе — здесь это предмет запроса, а
  правило «идентификатора организации нет в API» относится к кабинету клиента;
* правка меняет **только** поля, пришедшие в теле (`payload.model_fields_set`):
  иначе `PATCH` без `name` обнулил бы название, как это делает ручка кабинета,
  которая присваивает все пять полей безусловно;
* создания и удаления нет вовсе: `DELETE`-семантики в API нет, а организация
  без владельца невидима никому.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.organization import INN_CONFLICT_DETAIL, inn_taken, load_organization
from app.db import get_db
from app.models.dormitory import Dormitory
from app.models.organization import Organization, OrganizationMember
from app.schemas.organization import (
    INN_FORMAT_MESSAGE,
    NAME_REQUIRED_MESSAGE,
    UpdateOrganizationRequest,
)
from app.schemas.platform_organization import (
    PlatformOrganizationDetails,
    PlatformOrganizationListItem,
    PlatformOrganizationPage,
)
from app.schemas.user import ErrorResponse
from app.security import INVALID_OPERATOR_TOKEN_DETAIL, require_operator_service

# Зависимость стоит на роутере целиком: ни одна ручка платформенного контура не
# открывается без сервисного токена, и новая ручка не может её забыть.
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

# Умолчания и границы страницы. `limit` 1..100 — потолок нужен, чтобы один
# запрос не вытянул всю платформу: `LIMIT` задаёт клиент, а память наша.
DEFAULT_LIMIT = 50
MAX_LIMIT = 100
PageLimit = Annotated[int, Query(ge=1, le=MAX_LIMIT)]
PageOffset = Annotated[int, Query(ge=0)]

LIST_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "`limit` вне 1..100 или `offset` меньше нуля",
    },
}

DETAILS_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Организация не найдена",
    },
}

UPDATE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": "Организация не найдена",
    },
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": INN_CONFLICT_DETAIL,
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": f"{NAME_REQUIRED_MESSAGE} или {INN_FORMAT_MESSAGE}",
    },
}


def _members_count_subquery() -> Any:
    """Скалярный подзапрос: сколько строк членства у организации.

    Владелец считается — в кабинете оператора это «сколько людей в организации».
    """
    return (
        select(func.count())
        .select_from(OrganizationMember)
        .where(OrganizationMember.organization_id == Organization.id)
        .scalar_subquery()
    )


def _dormitories_count_subquery() -> Any:
    """Скалярный подзапрос: сколько общежитий у организации, включая архивные."""
    return (
        select(func.count())
        .select_from(Dormitory)
        .where(Dormitory.organization_id == Organization.id)
        .scalar_subquery()
    )


def _details(db: Session, organization: Organization) -> PlatformOrganizationDetails:
    """Карточка организации вместе со счётчиками — одним запросом, а не тремя.

    Счётчики берутся двумя скалярными подзапросами в одном `SELECT`: запрос на
    каждую организацию в списке было бы N+1, а здесь карточка всегда одна.
    """
    members_count, dormitories_count = db.execute(
        select(_members_count_subquery(), _dormitories_count_subquery()).where(
            Organization.id == organization.id
        )
    ).one()
    return PlatformOrganizationDetails(
        id=organization.id,
        name=organization.name,
        inn=organization.inn,
        kpp=organization.kpp,
        ogrn=organization.ogrn,
        address=organization.address,
        created_at=organization.created_at,
        members_count=members_count,
        dormitories_count=dormitories_count,
    )


@router.get(
    "",
    response_model=PlatformOrganizationPage,
    summary="Список организаций платформы",
    responses=LIST_RESPONSES,
)
def list_organizations(
    db: DbSession,
    limit: PageLimit = DEFAULT_LIMIT,
    offset: PageOffset = 0,
) -> PlatformOrganizationPage:
    """Страница списка организаций: свежие сверху.

    Порядок — по убыванию `id`, а не по названию: `name` бывает `NULL`, и
    порядок по нему был бы разным в SQLite и PostgreSQL. `total` считается
    отдельным `count` по тем же условиям (условий фильтрации в этой задаче нет
    вовсе), поэтому он не зависит от страницы.
    """
    total = db.scalar(select(func.count()).select_from(Organization)) or 0
    rows = db.scalars(
        select(Organization).order_by(Organization.id.desc()).limit(limit).offset(offset)
    ).all()
    return PlatformOrganizationPage(
        items=[PlatformOrganizationListItem.model_validate(row) for row in rows],
        total=total,
    )


@router.get(
    "/{organization_id}",
    response_model=PlatformOrganizationDetails,
    summary="Карточка организации платформы",
    responses=DETAILS_RESPONSES,
)
def read_organization(organization_id: int, db: DbSession) -> PlatformOrganizationDetails:
    """Организация со счётчиками участников и общежитий.

    Неизвестный `id` — тот же `404` и тот же текст, что во всём API: загрузку
    организации делает `load_organization`, а не её копия.
    """
    return _details(db, load_organization(db, organization_id))


@router.patch(
    "/{organization_id}",
    response_model=PlatformOrganizationDetails,
    summary="Изменить данные организации",
    responses=UPDATE_RESPONSES,
)
def update_organization(
    organization_id: int,
    payload: UpdateOrganizationRequest,
    db: DbSession,
) -> PlatformOrganizationDetails:
    """Правка: меняются только поля, пришедшие в теле.

    `name: null` — `422`, а не очистка: название организации пустым быть не
    может, и это то же правило, по которому отвергается пустая строка. Отсутствие
    `name` в теле название не трогает вовсе — иначе `PATCH` одного адреса
    обнулил бы название.
    """
    organization = load_organization(db, organization_id)

    if "name" in payload.model_fields_set and payload.name is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, NAME_REQUIRED_MESSAGE)

    if (
        "inn" in payload.model_fields_set
        and payload.inn is not None
        and inn_taken(db, payload.inn, organization.id)
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, INN_CONFLICT_DETAIL)

    for field in payload.model_fields_set:
        setattr(organization, field, getattr(payload, field))
    try:
        db.commit()
    except IntegrityError:
        # Две одновременные правки на один ИНН: уникальный индекс сработал.
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, INN_CONFLICT_DETAIL) from None
    db.refresh(organization)
    return _details(db, organization)
