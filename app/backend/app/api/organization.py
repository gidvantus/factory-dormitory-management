"""Организация пользователя: чтение, правка, участники и приглашения.

Здесь два слоя сразу: хелпер, которым активация кабинета заводит владельцу
пустую организацию, и ручки `/api/organization`. Держим их в одном модуле
намеренно: правила доступа к организации — отдельный слой от аутентификации, и
когда появится переключение между организациями, переезд проверки членства
будет правкой одного файла.

Разные коды ошибок несут разный смысл и обязаны различаться:

* **404** — пользователь не привязан к организации (нет `active_organization_id`
  или нет строки членства);
* **403** — привязан, но править не может: роль не `owner` и не `admin`;
* **409** — ИНН уже занят другой организацией или email сотрудника занят.

Проверок по роли участника здесь нет намеренно: роль сотрудника — данные для
отображения, а не право. Права на правку организации остаются у `EDIT_ROLES`.
"""

import secrets
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.mail import send_invitation_email_task
from app.models.activation import ActivationToken
from app.models.organization import Organization, OrganizationMember
from app.models.user import User
from app.schemas.organization import (
    InviteMemberRequest,
    OrganizationMemberResponse,
    OrganizationResponse,
    UpdateOrganizationRequest,
)
from app.schemas.user import ErrorResponse, normalize_email
from app.security import (
    ACTIVE_USER_RESPONSES,
    ActiveUser,
    hash_password,
    issue_activation_token,
)

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
EMAIL_TAKEN_DETAIL = "Пользователь с таким email уже зарегистрирован"
INVALID_INVITATION_DETAIL = "Некорректный email, пустое ФИО или роль owner/member"

# Длина служебного пароля приглашённого (в байтах): он нужен только чтобы у
# неактивной строки был хеш, а пользователь задаёт свой пароль по ссылке.
SERVICE_PASSWORD_BYTES = 12

# Вид токена для письма-приглашения: по нему видно, откуда пришла ссылка.
INVITATION_TOKEN_KIND = "invitation"

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
        # Тело, которое не декодируется как UTF-8, FastAPI превращает в 400
        # «There was an error parsing the body» — этот код обязан быть в схеме.
        status.HTTP_400_BAD_REQUEST: {
            "model": ErrorResponse,
            "description": "Тело запроса не разбирается как JSON",
        },
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


def _member_response(member: OrganizationMember, user: User) -> OrganizationMemberResponse:
    """Собрать ответ по строке членства и её учётной записи."""
    return OrganizationMemberResponse(
        id=member.id,
        email=user.email,
        full_name=user.full_name,
        role=member.role,
        is_active=user.is_active,
        created_at=member.created_at,
    )


@router.get(
    "/members",
    response_model=list[OrganizationMemberResponse],
    summary="Участники организации",
    responses=NOT_FOUND_RESPONSES,
)
def read_members(membership: Membership, db: DbSession) -> list[OrganizationMemberResponse]:
    """Участники организации — любой её участник, роль значения не имеет.

    Приглашённый, который ещё не открыл письмо, тоже в списке: `is_active`
    отличает его от того, кто уже активировал кабинет.
    """
    rows = db.execute(
        select(OrganizationMember, User)
        .join(User, User.id == OrganizationMember.user_id)
        .where(OrganizationMember.organization_id == membership.organization_id)
        .order_by(OrganizationMember.id)
    ).all()
    return [_member_response(member, user) for member, user in rows]


@router.post(
    "/invitations",
    status_code=status.HTTP_201_CREATED,
    response_model=OrganizationMemberResponse,
    summary="Пригласить сотрудника в организацию",
    responses={
        **NOT_FOUND_RESPONSES,
        status.HTTP_400_BAD_REQUEST: {
            "model": ErrorResponse,
            "description": "Тело запроса не разбирается как JSON",
        },
        status.HTTP_409_CONFLICT: {
            "model": ErrorResponse,
            "description": EMAIL_TAKEN_DETAIL,
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": INVALID_INVITATION_DETAIL,
        },
    },
)
def invite_member(
    payload: InviteMemberRequest,
    background_tasks: BackgroundTasks,
    membership: Membership,
    db: DbSession,
) -> OrganizationMemberResponse:
    """Завести неактивного сотрудника в организации приглашающего и позвать его письмом.

    Приглашённый появляется сразу: неактивная учётная запись, строки членства и
    живая ссылка-приглашение сохраняются одним коммитом, а письмо уходит фоном
    уже после ответа. Ссылка ведёт на общий экран активации: задав пароль,
    сотрудник попадает в организацию приглашающего, а не заводит свою.

    Роль проверяется только схемой (`admin`, `manager`, `commandant`): прав по
    ней в этой задаче нет, она хранится и показывается.
    """
    email = normalize_email(payload.email)

    # Занятый email — 409 до любых вставок: ничего не создаём и письма не шлём.
    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, EMAIL_TAKEN_DETAIL)

    user = User(
        email=email,
        full_name=payload.full_name,
        # Пароль служебный: пользователь его не видит и заменяет своим по ссылке.
        password_hash=hash_password(secrets.token_urlsafe(SERVICE_PASSWORD_BYTES)),
        is_active=False,
    )
    db.add(user)
    try:
        db.flush()
        member = OrganizationMember(
            organization_id=membership.organization_id,
            user_id=user.id,
            role=payload.role,
        )
        db.add(member)
        db.flush()
        user.active_organization_id = membership.organization_id
        # Прежние живые ссылки гасим: у письма должна быть ровно одна рабочая.
        db.execute(
            update(ActivationToken)
            .where(ActivationToken.user_id == user.id, ActivationToken.used_at.is_(None))
            .values(used_at=datetime.now(UTC))
        )
        token = issue_activation_token(db, user.id, kind=INVITATION_TOKEN_KIND)
        db.commit()
    except IntegrityError:
        # Гонка на email или на паре «организация — пользователь»: без отката
        # транзакция осталась бы сломанной и уронила следующий запрос.
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, EMAIL_TAKEN_DETAIL) from None
    db.refresh(member)
    db.refresh(user)

    background_tasks.add_task(
        send_invitation_email_task,
        to=user.email,
        full_name=user.full_name,
        token=token,
    )
    return _member_response(member, user)
