"""Права должностей: настройки платформы, доступные только оператору."""

from typing import Annotated, cast

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.role_permission import ACCESS_ROLES, RolePermission
from app.role_permissions import permissions_for
from app.schemas.role_permission import (
    AccessRole,
    RolePermissionResponse,
    UpdateRolePermissionRequest,
)
from app.schemas.user import ErrorResponse
from app.security import INVALID_OPERATOR_TOKEN_DETAIL, require_operator_service

router = APIRouter(
    prefix="/platform/access-rights",
    tags=["platform"],
    dependencies=[Depends(require_operator_service)],
    responses={401: {"model": ErrorResponse, "description": INVALID_OPERATOR_TOKEN_DETAIL}},
)
DbSession = Annotated[Session, Depends(get_db)]


@router.get("", response_model=list[RolePermissionResponse], summary="Права доступа должностей")
def read_access_rights(db: DbSession) -> list[RolePermissionResponse]:
    return [
        RolePermissionResponse(
            role=cast(AccessRole, role), **permissions_for(db, role).model_dump()
        )
        for role in ACCESS_ROLES
    ]


@router.patch(
    "/{role}",
    response_model=RolePermissionResponse,
    summary="Изменить права должности во всех организациях",
)
def update_access_rights(
    role: AccessRole, payload: UpdateRolePermissionRequest, db: DbSession
) -> RolePermissionResponse:
    # Имя не `row`: в `app/api` оно закреплено за строкой таблицы каталога, и
    # именно по нему инвентарь путей записи (`tests/test_notification_rule_write_paths.py`)
    # узнаёт точку записи, которой нужен `notify_row_written`. Права должности —
    # настройка платформы, строк каталога она не пишет.
    permission = db.get(RolePermission, role)
    if permission is None:
        permission = RolePermission(role=role)
        db.add(permission)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(permission, field, value)
    db.commit()
    db.refresh(permission)
    return RolePermissionResponse.model_validate(permission)
