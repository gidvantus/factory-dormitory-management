"""Регистрация, вход и выход.

Служебный пароль регистрации генерируется на сервере, хешируется и никогда не
покидает его: ни в ответе, ни в логах, ни в письме. Пользователь попадает в
кабинет только по ссылке активации (`app/api/activation.py`), где сам задаёт
новый пароль.
"""

import secrets
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.mail import activation_email_ready, send_activation_email_task
from app.models.user import User
from app.schemas.user import (
    ErrorResponse,
    LoginRequest,
    RegisterRequest,
    RegisterResponse,
    UserResponse,
    normalize_email,
)
from app.security import (
    create_access_token,
    expired_session_cookie,
    hash_password,
    issue_activation_token,
    session_cookie,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

DbSession = Annotated[Session, Depends(get_db)]

# Длина служебного пароля регистрации (в байтах, не в символах).
GENERATED_PASSWORD_BYTES = 12


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    response_model=RegisterResponse,
    summary="Зарегистрировать пользователя и отправить письмо активации",
    responses={
        status.HTTP_400_BAD_REQUEST: {
            "model": ErrorResponse,
            "description": "Тело запроса не разбирается как JSON",
        },
        status.HTTP_409_CONFLICT: {
            "model": ErrorResponse,
            "description": "Email уже занят",
        },
    },
)
def register(
    payload: RegisterRequest,
    background_tasks: BackgroundTasks,
    db: DbSession,
) -> RegisterResponse:
    email = normalize_email(payload.email)

    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Пользователь с таким email уже зарегистрирован",
        )

    # Пароль нужен только чтобы неактивный аккаунт не остался без хеша:
    # пользователю он не показывается, а при активации заменяется на новый.
    user = User(
        email=email,
        full_name=payload.full_name,
        password_hash=hash_password(secrets.token_urlsafe(GENERATED_PASSWORD_BYTES)),
        is_active=False,
    )
    db.add(user)
    try:
        db.flush()
        token = issue_activation_token(db, user.id)
        db.commit()
    except IntegrityError:
        # Две одновременные регистрации на один email: уникальный индекс сработал.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Пользователь с таким email уже зарегистрирован",
        ) from None
    db.refresh(user)

    background_tasks.add_task(
        send_activation_email_task,
        to=user.email,
        full_name=user.full_name,
        token=token,
    )

    return RegisterResponse(
        email=user.email,
        full_name=user.full_name,
        created_at=user.created_at,
        activation_email_sent=activation_email_ready(db),
    )


@router.post(
    "/login",
    response_model=UserResponse,
    summary="Войти по email и паролю",
    responses={
        status.HTTP_400_BAD_REQUEST: {
            "model": ErrorResponse,
            "description": "Тело запроса не разбирается как JSON",
        },
        status.HTTP_401_UNAUTHORIZED: {
            "model": ErrorResponse,
            "description": "Неверный email или пароль",
        },
    },
)
def login(payload: LoginRequest, response: Response, db: DbSession) -> UserResponse:
    email = normalize_email(payload.email)
    user = db.scalar(select(User).where(User.email == email))

    # Ответ одинаковый и для несуществующего email, и для неверного пароля.
    password_matches = user is not None and verify_password(payload.password, user.password_hash)
    if user is None or not password_matches:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный email или пароль",
        )

    # Неактивный вход разрешён: сессия нужна, чтобы фронт увидел `is_active: false`
    # и увёл на экран активации. Рабочие ручки закрыты `ActiveUser` и отвечают 403.
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
