"""Пользователи платформы: список, карточка и правка ФИО для кабинета оператора.

Контур отдельный, тот же, что у организаций (`app/api/platform_organizations.py`):
ручки открывает сервисный токен кабинета оператора (`X-Operator-Token`), а не
cookie основного кабинета. Своего хранилища у кабинета нет: читает и правит он
здесь, а источник правды, правила и журнал остаются в основном приложении.

Что здесь осознанно **не** так, как в кабинете клиента:

* `user_id` есть в пути и в ответе — здесь это предмет запроса, а не «свой
  профиль»;
* правка меняет **только** `full_name`: email в проекте и есть логин, роль
  решается отдельно (#100), а `is_active` значит «кабинет не активирован», а не
  «заблокирован». Ручки, которая меняет email, роль или активность, нет вовсе;
* роли и организации у пользователя может не быть: строка членства живёт в
  `organization_members`, и без неё `role` — `null`, а не выдуманное «участник».
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.organization import Organization, OrganizationMember
from app.models.user import User
from app.schemas.platform_user import PlatformUser, PlatformUserPage, PlatformUserUpdate
from app.schemas.user import ErrorResponse
from app.security import INVALID_OPERATOR_TOKEN_DETAIL, require_operator_service
from app.sql_like import ESCAPE_CHARACTER, like_pattern

# Текст отказа — часть контракта: кабинет передаёт его дословно, а тестировщик
# сверяет построчно. Поэтому константа одна на роутер и на тесты.
USER_NOT_FOUND_DETAIL = "Пользователь не найден"

# Зависимость стоит на роутере целиком: ни одна ручка платформенного контура не
# открывается без сервисного токена, и новая ручка не может её забыть.
router = APIRouter(
    prefix="/platform/users",
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

# Умолчания и границы страницы те же, что у списка организаций: `limit` 1..100,
# иначе один запрос вытянул бы все учётные записи платформы.
DEFAULT_LIMIT = 50
MAX_LIMIT = 100
PageLimit = Annotated[int, Query(ge=1, le=MAX_LIMIT)]
PageOffset = Annotated[int, Query(ge=0)]

# Потолок поисковой подстроки: её длину задаёт клиент, а `ILIKE` по префиксу
# `%…%` индексов не использует.
MAX_SEARCH_LENGTH = 100
SearchQuery = Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH)]

LIST_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "`limit` вне 1..100, `offset` меньше нуля или `search` длиннее 100 символов",
    },
}

DETAILS_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": USER_NOT_FOUND_DETAIL,
    },
}

UPDATE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": USER_NOT_FOUND_DETAIL,
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "ФИО не может быть пустым или в теле есть лишнее поле",
    },
}


def _search_condition(search: str) -> ColumnElement[bool]:
    """Подстрока без учёта регистра по email **или** ФИО."""
    pattern = like_pattern(search)
    return or_(
        User.email.ilike(pattern, escape=ESCAPE_CHARACTER),
        User.full_name.ilike(pattern, escape=ESCAPE_CHARACTER),
    )


def _user_query() -> Any:
    """Выборка строки реестра: учётная запись плюс её организация и роль.

    Джойны внешние: пользователь без организации — нормальное состояние
    (неактивированный кабинет), и он обязан остаться в списке с `null` в
    организации и роли. Членство ищется по той же паре, что и
    `active_organization_id`: организации «вообще» у пользователя нет.
    """
    return (
        select(
            User.id,
            User.email,
            User.full_name,
            User.is_active,
            User.created_at,
            Organization.id.label("organization_id"),
            Organization.name.label("organization_name"),
            OrganizationMember.role.label("role"),
        )
        .select_from(User)
        .outerjoin(Organization, Organization.id == User.active_organization_id)
        .outerjoin(
            OrganizationMember,
            (OrganizationMember.organization_id == User.active_organization_id)
            & (OrganizationMember.user_id == User.id),
        )
    )


def _to_platform_user(row: Any) -> PlatformUser:
    """Строка выборки → схема ответа. Поля перечислены явно, а не `**row`."""
    return PlatformUser(
        id=row.id,
        email=row.email,
        full_name=row.full_name,
        is_active=row.is_active,
        organization_id=row.organization_id,
        organization_name=row.organization_name,
        role=row.role,
        created_at=row.created_at,
    )


@router.get(
    "",
    response_model=PlatformUserPage,
    summary="Список пользователей платформы",
    responses=LIST_RESPONSES,
)
def list_users(
    db: DbSession,
    limit: PageLimit = DEFAULT_LIMIT,
    offset: PageOffset = 0,
    search: SearchQuery = None,
) -> PlatformUserPage:
    """Страница реестра учётных записей: свежие сверху.

    Порядок — по убыванию `id`, а не по ФИО: регистр и алфавит в SQLite и
    PostgreSQL сравниваются по-разному, а `id` даёт устойчивые страницы без
    дублей и пропусков. `total` считается отдельным `count` по тем же условиям,
    поэтому не зависит от `limit`/`offset`.
    """
    query = (search or "").strip()
    conditions = [_search_condition(query)] if query else []

    total = db.scalar(select(func.count()).select_from(User).where(*conditions)) or 0
    rows = db.execute(
        _user_query().where(*conditions).order_by(User.id.desc()).limit(limit).offset(offset)
    ).all()
    return PlatformUserPage(items=[_to_platform_user(row) for row in rows], total=total)


@router.get(
    "/{user_id}",
    response_model=PlatformUser,
    summary="Карточка пользователя платформы",
    responses=DETAILS_RESPONSES,
)
def read_user(user_id: int, db: DbSession) -> PlatformUser:
    """Одна учётная запись: те же поля и те же джойны, что в списке.

    Неизвестный `id` — `404` с текстом `USER_NOT_FOUND_DETAIL`, чтобы кабинет
    показал его дословно, а не собирал свой.
    """
    if db.get(User, user_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, USER_NOT_FOUND_DETAIL)
    row = db.execute(_user_query().where(User.id == user_id)).one()
    return _to_platform_user(row)


@router.patch(
    "/{user_id}",
    response_model=PlatformUser,
    summary="Изменить ФИО пользователя",
    responses=UPDATE_RESPONSES,
)
def update_user(user_id: int, payload: PlatformUserUpdate, db: DbSession) -> PlatformUser:
    """Правка одного поля: меняется только ФИО.

    Остальные поля объекта не трогаются вовсе: email, роль, организация и
    `is_active` — только чтение. Значение уже схлопнуто по пробелам валидатором
    схемы, пустая строка до обработчика не доходит.
    """
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, USER_NOT_FOUND_DETAIL)
    user.full_name = payload.full_name
    db.commit()
    db.refresh(user)
    row = db.execute(_user_query().where(User.id == user_id)).one()
    return _to_platform_user(row)
