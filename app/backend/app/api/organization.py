"""Организация пользователя: чтение и правка.

Здесь два слоя сразу: хелпер, которым активация кабинета заводит владельцу
пустую организацию, и ручки `/api/organization`. Держим их в одном модуле
намеренно: правила доступа к организации — отдельный слой от аутентификации, и
когда появится переключение между организациями, переезд проверки членства
будет правкой одного файла.

Разные коды ошибок несут разный смысл и обязаны различаться:

* **404** — пользователь не привязан к организации (нет `active_organization_id`
  или нет строки членства);
* **403** — привязан, но править не может: роль не `owner` и не `admin`;
* **409** — ИНН уже занят другой организацией.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.organization import Organization, OrganizationMember
from app.models.user import User
from app.schemas.organization import OrganizationResponse, UpdateOrganizationRequest
from app.schemas.user import ErrorResponse
from app.security import ACTIVE_USER_RESPONSES, ActiveUser

router = APIRouter(
    prefix="/organization",
    tags=["organization"],
    responses={
        401: {"model": ErrorResponse, "description": "Требуется авторизация"},
        **ACTIVE_USER_RESPONSES,
    },
)
DbSession = Annotated[Session, Depends(get_db)]

ORGANIZATION_NOT_FOUND_DETAIL = "Организация не найдена"
ORGANIZATION_EDIT_FORBIDDEN_DETAIL = "Недостаточно прав"
INN_CONFLICT_DETAIL = "Организация с таким ИНН уже есть"

# Роли, которым разрешена правка. Остальные роли читают организацию, но не меняют.
EDIT_ROLES = frozenset({"owner", "admin"})

NOT_FOUND_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": ORGANIZATION_NOT_FOUND_DETAIL,
    },
}


def create_organization_for_user(db: Session, user: User) -> Organization:
    """Завести пользователю пустую организацию и сделать его владельцем.

    Название и ИНН остаются `NULL`: это пустая заготовка, которую пользователь
    заполнит на странице «Организация». Коммитит вызывающий — активация
    сохраняет организацию и саму активацию одним коммитом.
    """
    organization = Organization(name=None, inn=None)
    db.add(organization)
    # `flush` нужен, чтобы получить `id` организации до вставки строки членства.
    db.flush()
    db.add(
        OrganizationMember(
            organization_id=organization.id,
            user_id=user.id,
            role="owner",
        )
    )
    user.active_organization_id = organization.id
    return organization


def require_organization_membership(user: ActiveUser, db: DbSession) -> OrganizationMember:
    """Членство текущего пользователя в его организации. Иначе — 404.

    Проверяются оба условия: и заполненный `active_organization_id`, и реальная
    строка членства. Одной ссылки в `users` мало — она может пережить удаление
    строки членства.
    """
    if user.active_organization_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)

    membership = db.scalar(
        select(OrganizationMember).where(
            OrganizationMember.organization_id == user.active_organization_id,
            OrganizationMember.user_id == user.id,
        )
    )
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)
    return membership


# Внутренняя зависимость. Тип возврата `None`, а не строка членства: FastAPI
# берёт аннотацию возврата зависимости за модель ответа и на модели SQLAlchemy
# падает с «Invalid args for response field» ещё на импорте приложения.
def _require_organization_edit(membership: OrganizationMember) -> None:
    if membership.role not in EDIT_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, ORGANIZATION_EDIT_FORBIDDEN_DETAIL)


# Тот же смысл, но пригодный для `Depends`: параметр — готовая зависимость
# членства, возврат — сама строка членства. FastAPI в пределах запроса кеширует
# результат, поэтому проверка и роут обходятся одним запросом в базу.
def require_organization_edit(
    membership: Annotated[OrganizationMember, Depends(require_organization_membership)],
) -> OrganizationMember:
    """Членство с ролью из `EDIT_ROLES`. Иначе — 403 «Недостаточно прав»."""
    _require_organization_edit(membership)
    return membership


Membership = Annotated[OrganizationMember, Depends(require_organization_membership)]
EditableMembership = Annotated[OrganizationMember, Depends(require_organization_edit)]


def _load_organization(db: Session, organization_id: int) -> Organization:
    organization = db.get(Organization, organization_id)
    if organization is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)
    return organization


@router.get(
    "",
    response_model=OrganizationResponse,
    summary="Организация пользователя",
    responses=NOT_FOUND_RESPONSES,
)
def read_organization(membership: Membership, db: DbSession) -> OrganizationResponse:
    """Любой участник организации, роль не важна: это чтение своих данных."""
    return OrganizationResponse.model_validate(_load_organization(db, membership.organization_id))


@router.patch(
    "",
    response_model=OrganizationResponse,
    summary="Изменить название и ИНН организации",
    responses={
        **NOT_FOUND_RESPONSES,
        status.HTTP_409_CONFLICT: {
            "model": ErrorResponse,
            "description": INN_CONFLICT_DETAIL,
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "Некорректный ИНН или пустое название",
        },
    },
)
def update_organization(
    payload: UpdateOrganizationRequest,
    membership: EditableMembership,
    db: DbSession,
) -> OrganizationResponse:
    organization = _load_organization(db, membership.organization_id)

    if payload.inn is not None and _inn_taken(db, payload.inn, organization.id):
        raise HTTPException(status.HTTP_409_CONFLICT, INN_CONFLICT_DETAIL)

    organization.name = payload.name
    organization.inn = payload.inn
    try:
        db.commit()
    except IntegrityError:
        # Две одновременные правки на один ИНН: уникальный индекс сработал.
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, INN_CONFLICT_DETAIL) from None
    db.refresh(organization)
    return OrganizationResponse.model_validate(organization)


def _inn_taken(db: Session, inn: str, organization_id: int) -> bool:
    """Занят ли ИНН другой организацией. Своя собственная — не конфликт."""
    return (
        db.scalar(
            select(Organization.id).where(
                Organization.inn == inn,
                Organization.id != organization_id,
            )
        )
        is not None
    )
