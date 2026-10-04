"""Профиль текущего пользователя."""

from fastapi import APIRouter, status

from app.schemas.user import ErrorResponse, UserResponse
from app.security import CurrentUser

router = APIRouter(tags=["users"])


@router.get(
    "/me",
    response_model=UserResponse,
    summary="Данные текущего пользователя",
    responses={
        status.HTTP_401_UNAUTHORIZED: {
            "model": ErrorResponse,
            "description": "Нет валидной cookie сессии",
        },
    },
)
def read_me(user: CurrentUser) -> UserResponse:
    return UserResponse.model_validate(user)
