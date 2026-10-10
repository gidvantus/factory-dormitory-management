"""Активация личного кабинета по ссылке из письма.

Токен из письма приходит открытым текстом и сразу превращается в SHA-256:
в базе лежит только хеш. Ссылка одноразовая — успешная активация помечает
токен `used_at`, повторный переход отвечает 410.
"""

import logging
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Response, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.organization import create_organization_for_user
from app.api.recovery import RECOVERY_LIMIT_LOG, identifier_hash, try_consume_request
from app.db import get_db
from app.mail import send_activation_email_task
from app.models.activation import ActivationToken
from app.models.user import User
from app.schemas.activation import (
    ActivateRequest,
    ActivationInfoResponse,
    ResendActivationRequest,
    ResendActivationResponse,
)
from app.schemas.user import ErrorResponse, UserResponse, normalize_email
from app.security import (
    create_access_token,
    hash_activation_token,
    hash_password,
    issue_activation_token,
    session_cookie,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["activation"])
DbSession = Annotated[Session, Depends(get_db)]

# Разные тексты 410: экран должен объяснить, что именно не так со ссылкой.
UNKNOWN_TOKEN_DETAIL = "Ссылка активации не найдена"
USED_TOKEN_DETAIL = "Ссылка активации уже использована"
EXPIRED_TOKEN_DETAIL = "Срок действия ссылки активации истёк"

# Ответ повторной отправки одинаков и для существующей почты, и для чужой.
RESEND_DETAIL = "Если такой адрес зарегистрирован, письмо отправлено повторно"

GONE_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_410_GONE: {
        "model": ErrorResponse,
        "description": "Ссылка не найдена, уже использована или просрочена",
    },
}


def _as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: считаем его UTC, иначе сравнение падает."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def load_activation_token(db: Session, token: str) -> tuple[ActivationToken, User]:
    """Достать живой токен вместе с его владельцем. Иначе — 410 с причиной."""
    record = db.scalar(
        select(ActivationToken).where(ActivationToken.token_hash == hash_activation_token(token))
    )
    if record is None:
        raise HTTPException(status.HTTP_410_GONE, UNKNOWN_TOKEN_DETAIL)
    if record.used_at is not None:
        raise HTTPException(status.HTTP_410_GONE, USED_TOKEN_DETAIL)
    if _as_utc(record.expires_at) <= datetime.now(UTC):
        raise HTTPException(status.HTTP_410_GONE, EXPIRED_TOKEN_DETAIL)

    user = db.get(User, record.user_id)
    if user is None:
        raise HTTPException(status.HTTP_410_GONE, UNKNOWN_TOKEN_DETAIL)
    return record, user


@router.get(
    "/activate/{token}",
    response_model=ActivationInfoResponse,
    summary="Проверить ссылку активации",
    responses=GONE_RESPONSES,
)
def read_activation(
    token: Annotated[str, Path(min_length=1, max_length=512)],
    db: DbSession,
) -> ActivationInfoResponse:
    record, user = load_activation_token(db, token)
    return ActivationInfoResponse(
        email=user.email,
        full_name=user.full_name,
        expires_at=record.expires_at,
    )


@router.post(
    "/activate",
    response_model=UserResponse,
    summary="Задать пароль по ссылке и открыть кабинет",
    responses={
        **GONE_RESPONSES,
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "Пароль короче восьми символов",
        },
    },
)
def activate(payload: ActivateRequest, response: Response, db: DbSession) -> UserResponse:
    record, user = load_activation_token(db, payload.token)

    user.password_hash = hash_password(payload.password)
    user.is_active = True
    record.used_at = datetime.now(UTC)

    # Момент «появления» аккаунта: пользователь впервые входит в кабинет, значит
    # ему нужна своя организация. Проверка на `None` делает повторную активацию
    # безопасной — второй организации у пользователя не появится.
    if user.active_organization_id is None:
        create_organization_for_user(db, user)

    db.commit()
    db.refresh(user)

    response.set_cookie(value=create_access_token(str(user.id)), **session_cookie())
    return UserResponse.model_validate(user)


@router.post(
    "/activate/resend",
    response_model=ResendActivationResponse,
    summary="Отправить письмо активации ещё раз",
    responses={
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "Тело запроса не разбирается как JSON",
        },
    },
)
def resend_activation(
    payload: ResendActivationRequest,
    background_tasks: BackgroundTasks,
    db: DbSession,
) -> ResendActivationResponse:
    """Ответ всегда 200: по коду нельзя узнать, зарегистрирована ли почта."""
    user = db.scalar(select(User).where(User.email == normalize_email(payload.email)))

    if user is not None and not user.is_active:
        # Общий с лимитом восстановления счётчик: чередованием двух ручек его не обойти.
        if not try_consume_request(db, payload.email):
            logger.info("%s: %s", RECOVERY_LIMIT_LOG, identifier_hash(payload.email))
            return ResendActivationResponse(detail=RESEND_DETAIL)

        # Прежние ссылки гасим, чтобы у письма всегда была ровно одна живая.
        db.execute(
            update(ActivationToken)
            .where(ActivationToken.user_id == user.id, ActivationToken.used_at.is_(None))
            .values(used_at=datetime.now(UTC))
        )
        token = issue_activation_token(db, user.id, kind="activation")
        db.commit()
        background_tasks.add_task(
            send_activation_email_task,
            to=user.email,
            full_name=user.full_name,
            token=token,
        )

    return ResendActivationResponse(detail=RESEND_DETAIL)
