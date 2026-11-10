"""Профиль текущего пользователя."""

from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.organization import membership_role
from app.db import get_db
from app.role_permissions import permissions_for
from app.schemas.user import ErrorResponse, MeResponse
from app.security import CurrentUser

router = APIRouter(tags=["users"])
DbSession = Annotated[Session, Depends(get_db)]


@router.get(
    "/me",
    response_model=MeResponse,
    summary="Данные текущего пользователя",
    responses={
        status.HTTP_401_UNAUTHORIZED: {
            "model": ErrorResponse,
            "description": "Нет валидной cookie сессии",
        },
    },
)
def read_me(user: CurrentUser, db: DbSession) -> MeResponse:
    """Профиль, роль и текущие права на разделы, импорт и экспорт.

    Роль собирается отдельным запросом, а не берётся из `User`: строки членства
    в `users` нет. Права определяют доступные разделы меню и действия обмена
    данными. Схема `MeResponse`, а не
    `UserResponse`, чтобы ответы входа, регистрации и активации не изменились.

    Неактивному пользователю ответ тоже `200`: роль у него уже может быть
    (`admin` приглашённого кабинета), а `is_active` говорит, что кабинет ещё не
    активирован.
    """
    role = membership_role(user, db)
    return MeResponse(
        email=user.email,
        full_name=user.full_name,
        created_at=user.created_at,
        is_active=user.is_active,
        role=role,
        permissions=permissions_for(db, role),
    )
