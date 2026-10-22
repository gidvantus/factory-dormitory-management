"""Проверки доступа, не сводящиеся к аутентификации.

`security.py` отвечает на вопрос «кто это» и «активирован ли кабинет». Здесь
следующий слой: **работает** ли кабинет сейчас — активирован и не закрыт
истёкшим пробным периодом без тарифа, — и **чьи** данные он видит: данные
кабинета принадлежат организации, и точка правды о принадлежности одна —
`dormitories.organization_id`.

Две зависимости разделены намеренно. `ActiveUser` пускает любого активированного
пользователя: экран активации, профиль и разделы организации обязаны работать и
на закрытом кабинете. `SubscribedUser` добавляет к этому проверку пробного
периода и стоит только на рабочих разделах.

Границы данных стережёт `OwnDormitory` — единая зависимость вместо проверки в
каждом обработчике. Правило одно: общежитие либо принадлежит организации из
сессии, либо его **нет**. Чужое и несуществующее неразличимы намеренно: `404` с
одним и тем же текстом, никогда `403` — иначе по коду ответа видно, что объект с
таким номером существует. Новые маршруты с `{dormitory_id}` обязаны объявлять
`OwnDormitory`; это проверяет инвентарный тест `tests/test_route_guard_inventory.py`,
а не память разработчика.
"""

from typing import Annotated, Any

from fastapi import Depends, HTTPException, Path, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.organization import Membership
from app.db import get_db
from app.models.dormitory import Dormitory
from app.models.organization import OrganizationMember
from app.models.user import User
from app.schemas.user import ErrorResponse
from app.security import ACTIVATION_REQUIRED_DETAIL, ActiveUser
from app.trial import TRIAL_EXPIRED_DETAIL, trial_state

DbSession = Annotated[Session, Depends(get_db)]

# Один текст на «общежития нет» и «общежитие чужое»: различать их нельзя.
DORMITORY_NOT_FOUND_DETAIL = "Общежитие не найдено"


def require_subscribed_user(user: ActiveUser, db: DbSession) -> User:
    """Активированный пользователь с работающим кабинетом. Иначе — 403.

    Порядок проверок важен: неактивированный получает **свой** текст
    «Активируйте личный кабинет» (`require_active_user` идёт первым), и только
    активированный, но закрытый кабинет — текст про выбор тарифа.
    """
    if trial_state(db, user).locked:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=TRIAL_EXPIRED_DETAIL,
        )
    return user


SubscribedUser = Annotated[User, Depends(require_subscribed_user)]

# Единое описание 403 рабочих роутеров: у кода два разных текста, и оба здесь.
SUBSCRIBED_USER_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": (
            f"{ACTIVATION_REQUIRED_DETAIL} — кабинет не активирован; "
            f"{TRIAL_EXPIRED_DETAIL} — пробный период закончился"
        ),
    }
}


def own_dormitory(db: Session, dormitory_id: int, membership: OrganizationMember) -> Dormitory:
    """Общежитие организации из сессии. Иначе — тот же `404`, что и «не найдено».

    Проверка нужна и там, где `dormitory_id` приходит телом запроса, а не путём:
    зависимость на путь такие ручки не закрывает.
    """
    dormitory = db.get(Dormitory, dormitory_id)
    if dormitory is None or dormitory.organization_id != membership.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, DORMITORY_NOT_FOUND_DETAIL)
    return dormitory


def require_own_dormitory(
    dormitory_id: Annotated[int, Path(ge=1, le=2147483647)],
    membership: Membership,
    db: DbSession,
) -> Dormitory:
    """Зависимость для путей с `{dormitory_id}`.

    Выполняется до тела обработчика, поэтому права проверяются **раньше**
    блокировки общежития и любых действий с его строками: чужой объект не успеет
    ни заблокироваться, ни измениться.
    """
    return own_dormitory(db, dormitory_id, membership)


OwnDormitory = Annotated[Dormitory, Depends(require_own_dormitory)]


def organization_dormitories(db: Session, organization_id: int) -> list[Dormitory]:
    """Общежития организации — единственная выборка для «всех общежитий»."""
    return list(
        db.scalars(
            select(Dormitory)
            .where(Dormitory.organization_id == organization_id)
            .order_by(Dormitory.created_at.desc(), Dormitory.id.desc())
        )
    )


def organization_dormitory_ids(db: Session, organization_id: int) -> list[int]:
    """Те же общежития, но только `id`: фильтр для выборок «по всем»."""
    return list(
        db.scalars(select(Dormitory.id).where(Dormitory.organization_id == organization_id))
    )


def scoped_dormitories(db: Session, organization_id: int) -> list[Dormitory]:
    """Общежития организации в порядке `id` — для расчётов «по всем общежитиям»."""
    return list(
        db.scalars(
            select(Dormitory)
            .where(Dormitory.organization_id == organization_id)
            .order_by(Dormitory.id)
        )
    )
