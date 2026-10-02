"""Регистрация, вход и выход.

Открытый пароль живёт только внутри функции `register`: он возвращается в ответе
и нигде не логируется. Ни один роут не пишет пароль в logger.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.user import User
from app.schemas.user import (
    LoginRequest,
    RegisterRequest,
    RegisterResponse,
    UserResponse,
    normalize_email,
)
from app.security import (
    create_access_token,
    expired_session_cookie,
    generate_password,
    hash_password,
    session_cookie,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

DbSession = Annotated[Session, Depends(get_db)]


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    response_model=RegisterResponse,
    summary="Зарегистрировать пользователя и один раз показать пароль",
)
def register(payload: RegisterRequest, db: DbSession) -> RegisterResponse:
    email = normalize_email(payload.email)

    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Пользователь с таким email уже зарегистрирован",
        )

    password = generate_password()
    user = User(email=email, full_name=payload.full_name, password_hash=hash_password(password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # Две одновременные регистрации на один email: уникальный индекс сработал.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Пользователь с таким email уже зарегистрирован",
        ) from None
    db.refresh(user)

    return RegisterResponse(
        email=user.email,
        full_name=user.full_name,
        password=password,
        created_at=user.created_at,
    )


@router.post(
    "/login",
    response_model=UserResponse,
    summary="Войти по email и паролю",
)
def login(payload: LoginRequest, response: Response, db: DbSession) -> UserResponse:
    email = normalize_email(payload.email)
    user = db.scalar(select(User).where(User.email == email))

    # Ответ одинаковый и для несуществующего email, и для неверного пароля.
    password_matches = user is not None and verify_password(payload.password, user.password_hash)
    if user is None or not user.is_active or not password_matches:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный email или пароль",
        )

    response.set_cookie(value=create_access_token(str(user.id)), **session_cookie())
    return UserResponse.model_validate(user)


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Выйти и погасить cookie сессии",
)
def logout() -> Response:
    """Выход: гасим cookie сессии. Тела у ответа нет."""
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(**expired_session_cookie())
    return response
