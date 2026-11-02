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

Роль — это право ровно там, где модуль её проверяет, и проверок здесь две:
правка организации открыта `EDIT_ROLES` (`EditableMembership`), а разделы уровня
владельца — только `OWNER_ROLE` (`OwnerMembership`). Остальных проверок по роли
нет намеренно: роль сотрудника — данные для отображения, а не право.
"""

import secrets
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import dadata
from app.config import get_settings
from app.db import get_db
from app.mail import send_invitation_email_task
from app.models.activation import ActivationToken
from app.models.organization import Organization, OrganizationMember
from app.models.tariff import Tariff
from app.models.user import User
from app.schemas.organization import (
    INN_FORMAT_MESSAGE,
    InviteMemberRequest,
    OrganizationLookupDetails,
    OrganizationLookupResponse,
    OrganizationMemberResponse,
    OrganizationResponse,
    UpdateOrganizationRequest,
    normalize_inn,
)
from app.schemas.user import ErrorResponse, normalize_email
from app.security import (
    ACTIVE_USER_RESPONSES,
    ActiveUser,
    hash_password,
    issue_activation_token,
)
from app.subscription import (
    MEMBER_LIMIT_HEADER,
    MEMBER_LIMIT_HEADER_VALUE,
    subscription_state,
)
from app.trial import trial_state

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

# Роль владельца: она не считается сотрудником в пределе мест.
OWNER_ROLE = "owner"

# Описание заголовка отказа по местам для опубликованной схемы.
MEMBER_LIMIT_HEADER_DESCRIPTION = (
    f"Отказ по пределу мест: тариф или пробный период (значение: {MEMBER_LIMIT_HEADER_VALUE})"
)

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


def _require_organization_owner(membership: OrganizationMember) -> None:
    """Только владелец. Сотрудник с любой другой ролью получает тот же 403."""
    if membership.role != OWNER_ROLE:
        raise HTTPException(status.HTTP_403_FORBIDDEN, ORGANIZATION_EDIT_FORBIDDEN_DETAIL)


def require_organization_owner(
    membership: Annotated[OrganizationMember, Depends(require_organization_membership)],
) -> OrganizationMember:
    """Членство владельца организации. Иначе — 403 «Недостаточно прав».

    `EDIT_ROLES` здесь мало: правка организации открыта и `admin`, а разделы
    уровня владельца (журнал действий) — нет. `404` для пользователя без
    организации приходит из `require_organization_membership` и от роли не
    зависит, поэтому «нет кабинета» и «нет права» различимы на клиенте.
    """
    _require_organization_owner(membership)
    return membership


def membership_role(user: User, db: Session) -> str | None:
    """Роль текущего пользователя в его организации. `None` — организации нет.

    Проверяются те же два условия, что и в `require_organization_membership`, но
    без 404: роль нужна и там, где пользователь ещё не активировал кабинет и
    отказ был бы неверным ответом (`GET /api/me`).
    """
    if user.active_organization_id is None:
        return None
    return db.scalar(
        select(OrganizationMember.role).where(
            OrganizationMember.organization_id == user.active_organization_id,
            OrganizationMember.user_id == user.id,
        )
    )


Membership = Annotated[OrganizationMember, Depends(require_organization_membership)]
EditableMembership = Annotated[OrganizationMember, Depends(require_organization_edit)]
OwnerMembership = Annotated[OrganizationMember, Depends(require_organization_owner)]


def _load_organization(db: Session, organization_id: int) -> Organization:
    organization = db.get(Organization, organization_id)
    if organization is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)
    return organization


def _lock_organization(db: Session, organization_id: int) -> Organization:
    """Заблокировать строку организации на время транзакции.

    Два одновременных приглашения иначе посчитали бы сотрудников по одному и
    тому же состоянию и вместе проскочили бы лимит пробного периода.
    """
    organization = db.scalar(
        select(Organization).where(Organization.id == organization_id).with_for_update()
    )
    if organization is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)
    return organization


def _employee_count(db: Session, organization_id: int) -> int:
    """Сколько сотрудников в организации, не считая владельца."""
    return (
        db.scalar(
            select(func.count())
            .select_from(OrganizationMember)
            .where(
                OrganizationMember.organization_id == organization_id,
                OrganizationMember.role != OWNER_ROLE,
            )
        )
        or 0
    )


def _suggested_tariff_name(db: Session, limit: int) -> str | None:
    """Тариф, на который стоит перейти при пределе `limit`: ближайший просторный.

    Ищем среди опубликованного прайса ярус с наименьшим пределом, который больше
    текущего, а если такого нет — первый безлимитный. Имя берётся у месячной
    строки яруса: у остальных к названию добавлен срок, и в тексте отказа «Рост ·
    12 месяцев» читался бы как отдельный тариф.
    """
    candidates = list(
        db.scalars(
            select(Tariff).where(Tariff.is_visible.is_(True)).order_by(Tariff.position, Tariff.id)
        )
    )
    wider = [
        tariff
        for tariff in candidates
        if tariff.max_members is not None and tariff.max_members > limit
    ]
    if wider:
        # Ближайший ярус по местам, а внутри яруса — первая по порядку строка.
        best_limit = min(tariff.max_members for tariff in wider if tariff.max_members is not None)
        return next(tariff.name for tariff in wider if tariff.max_members == best_limit)
    unlimited = [tariff for tariff in candidates if tariff.max_members is None]
    return unlimited[0].name if unlimited else None


def _member_limit(db: Session, user: User, organization_id: int) -> tuple[int | None, str | None]:
    """Предел мест организации и тариф, на который стоит перейти.

    `None` в пределе — без ограничения: так продаётся безлимитный ярус, так
    работает закрытый кабинет без тарифа и пробного периода, и так же выглядит
    пробный период с незаданной настройкой `trial_member_limit`. Без тарифа
    предел даёт только заданная настройка пробного периода.
    """
    state = subscription_state(db, organization_id)
    if state.tariff is not None:
        limit = state.member_limit
    elif trial_state(db, user).is_active:
        limit = get_settings().trial_member_limit
    else:
        limit = None
    if limit is None:
        return None, None
    return limit, _suggested_tariff_name(db, limit)


def _member_limit_detail(limit: int, tariff_name: str | None) -> str:
    """Текст отказа по местам: дословно тот, что показывает фронт.

    Название тарифа подставляется только тогда, когда в прайсе есть куда
    переходить: обещать «перейдите на тариф», которого нет, нельзя.
    """
    if tariff_name is None:
        return f"Достигнут предел мест ({limit})"
    return f"Достигнут предел мест ({limit}). Перейдите на тариф «{tariff_name}»"


def _ensure_member_limit(db: Session, user: User, organization_id: int) -> None:
    """Отказать, когда приглашение упирается в предел мест.

    Предел — это `max_members` действующего тарифа, а без тарифа — настройка
    пробного периода `trial_member_limit`; незаданная настройка предела не
    даёт, и приглашения не ограничены. Понижение предела никогда не выгоняет
    людей: проверка стоит только на приглашении, поэтому уже приглашённые
    продолжают работать.

    Блокировка организации нужна и здесь: два одновременных приглашения иначе
    посчитали бы сотрудников по одному и тому же состоянию и вместе проскочили
    бы предел.
    """
    limit, tariff_name = _member_limit(db, user, organization_id)
    if limit is None:
        return
    _lock_organization(db, organization_id)
    if _employee_count(db, organization_id) >= limit:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            _member_limit_detail(limit, tariff_name),
            headers={MEMBER_LIMIT_HEADER: MEMBER_LIMIT_HEADER_VALUE},
        )


@router.get(
    "",
    response_model=OrganizationResponse,
    summary="Организация пользователя",
    responses=NOT_FOUND_RESPONSES,
)
def read_organization(membership: Membership, db: DbSession) -> OrganizationResponse:
    """Любой участник организации, роль не важна: это чтение своих данных."""
    return OrganizationResponse.model_validate(_load_organization(db, membership.organization_id))


@router.get(
    "/lookup",
    response_model=OrganizationLookupResponse,
    summary="Найти организацию по ИНН в DaData",
    responses={
        **NOT_FOUND_RESPONSES,
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": INN_FORMAT_MESSAGE,
        },
    },
)
def lookup_organization(
    inn: str, membership: Membership, db: DbSession
) -> OrganizationLookupResponse:
    """Подсказать реквизиты организации по ИНН.

    Доступ как у чтения организации (`Membership`), а не `EditableMembership`:
    поиск ничего не меняет, и роль без права правки им тоже пользуется.

    Неудачный поиск — это `200` с `found: false`, а не ошибка: форма остаётся
    рабочей, а пользователь видит разный текст для «не найдено», «сервис
    недоступен» и «ИНН занят другой организацией». `422` остаётся только за ИНН
    не по формату — это ошибка ввода.
    """
    try:
        normalized = normalize_inn(inn)
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, INN_FORMAT_MESSAGE) from None
    if normalized is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, INN_FORMAT_MESSAGE)

    # Занятый ИНН проверяется до похода в DaData: реквизиты чужой организации
    # пользователю не нужны, а ИНН в базе уникален — сохранить его всё равно
    # нельзя. Так о конфликте видно сразу при вводе, а не только после правки.
    if _inn_taken(db, normalized, membership.organization_id):
        return OrganizationLookupResponse(found=False, reason="inn_taken", details=None)

    try:
        found = dadata.lookup_organization(normalized)
    except dadata.DadataUnavailable:
        # Недоступность внешнего сервиса не блокирует сохранение: пользователь
        # проверяет ИНН сам, а причина ответа различима на форме.
        return OrganizationLookupResponse(found=False, reason="unavailable", details=None)

    if found is None:
        return OrganizationLookupResponse(found=False, reason="not_found", details=None)

    return OrganizationLookupResponse(
        found=True,
        reason=None,
        details=OrganizationLookupDetails(
            name=found.name,
            kpp=found.kpp,
            ogrn=found.ogrn,
            address=found.address,
        ),
    )


@router.patch(
    "",
    response_model=OrganizationResponse,
    summary="Изменить название, ИНН и реквизиты организации",
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
    organization.kpp = payload.kpp
    organization.ogrn = payload.ogrn
    organization.address = payload.address
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
            "description": (
                f"{EMAIL_TAKEN_DETAIL} или отказ по пределу мест (тариф или пробный период)"
            ),
            "headers": {
                MEMBER_LIMIT_HEADER: {
                    "description": MEMBER_LIMIT_HEADER_DESCRIPTION,
                    "schema": {"type": "string"},
                }
            },
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

    Предел мест берётся у действующего тарифа (`max_members`), а без тарифа —
    у настройки пробного периода (`trial_member_limit`); незаданная настройка
    значит «предела нет» и приглашения не ограничивает. Отказ приходит как `409`
    с заголовком `X-Member-Limit`: по нему фронт отличает предел мест от
    конфликта по занятому email, а текст отказа показывает дословно.
    """
    email = normalize_email(payload.email)

    caller = db.get(User, membership.user_id)
    if caller is None:  # pragma: no cover - строка членства без пользователя невозможна
        raise HTTPException(status.HTTP_404_NOT_FOUND, ORGANIZATION_NOT_FOUND_DETAIL)
    _ensure_member_limit(db, caller, membership.organization_id)

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
