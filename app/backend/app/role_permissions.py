"""Единая проверка импорта и экспорта: профиль и API используют одни правила."""

from typing import Annotated

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, DbSession, SubscribedUser
from app.api.organization import Membership
from app.models.role_permission import ACCESS_ROLES, RolePermission
from app.models.user import User
from app.schemas.role_permission import ExchangePermissions
from app.schemas.user import ErrorResponse

IMPORT_FORBIDDEN_DETAIL = "Нет права на импорт данных"
EXPORT_FORBIDDEN_DETAIL = "Нет права на экспорт данных"

EXCHANGE_USER_RESPONSES = {
    **SUBSCRIBED_USER_RESPONSES,
    403: {
        "model": ErrorResponse,
        "description": (
            f"{SUBSCRIBED_USER_RESPONSES[403]['description']}; "
            f"{IMPORT_FORBIDDEN_DETAIL}; {EXPORT_FORBIDDEN_DETAIL}"
        ),
    },
}


def permissions_for(db: Session, role: str | None) -> ExchangePermissions:
    if role == "owner":
        return ExchangePermissions(import_enabled=True, export_enabled=True)
    # Старые приглашения выдавали `member`; на них действуют права менеджера.
    if role == "member":
        role = "manager"
    if role not in ACCESS_ROLES:
        return ExchangePermissions(import_enabled=False, export_enabled=False)
    row = db.get(RolePermission, role)
    return ExchangePermissions(
        import_enabled=row.import_enabled if row is not None else True,
        export_enabled=row.export_enabled if row is not None else True,
    )


def require_import_user(user: SubscribedUser, membership: Membership, db: DbSession) -> User:
    if not permissions_for(db, membership.role).import_enabled:
        raise HTTPException(403, IMPORT_FORBIDDEN_DETAIL)
    return user


def require_export_user(user: SubscribedUser, membership: Membership, db: DbSession) -> User:
    if not permissions_for(db, membership.role).export_enabled:
        raise HTTPException(403, EXPORT_FORBIDDEN_DETAIL)
    return user


ImportUser = Annotated[User, Depends(require_import_user)]
ExportUser = Annotated[User, Depends(require_export_user)]
