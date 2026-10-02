"""Профиль текущего пользователя."""

from fastapi import APIRouter

from app.schemas.user import UserResponse
from app.security import CurrentUser

router = APIRouter(tags=["users"])


@router.get("/me", response_model=UserResponse, summary="Данные текущего пользователя")
def read_me(user: CurrentUser) -> UserResponse:
    return UserResponse.model_validate(user)
