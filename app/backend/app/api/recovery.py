"""Восстановление пароля: лимит отправок и ручка запроса письма.

Модуль держит и счётчик запросов, и свой `router`. `app.api.activation`
импортирует отсюда лимитер, обратного импорта нет — циклических зависимостей
не возникает.

Лимит скрытый: при исчерпанном окне ответ остаётся `200` с тем же текстом, что и
при успехе. Иначе по разнице ответов можно было бы перебирать адреса, которые
зарегистрированы в системе.
"""

import logging
from datetime import UTC, datetime, timedelta
from functools import partial
from hashlib import sha256
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.db import get_db
from app.mail import (
    RECOVERY_MAX_REQUESTS_PER_HOUR,
    RECOVERY_WINDOW_MINUTES,
    send_activation_email_task,
    send_password_recovery_email_task,
)
from app.models.activation import ActivationToken
from app.models.recovery_request import RecoveryRequest
from app.models.user import User
from app.schemas.activation import RecoveryRequestModel, ResendActivationResponse
from app.schemas.user import ErrorResponse, normalize_email
from app.security import issue_activation_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["recovery"])
DbSession = Annotated[Session, Depends(get_db)]

# Один и тот же ответ и для существующего адреса, и для чужого.
RECOVERY_DETAIL = "Если такой адрес зарегистрирован, письмо отправлено"

# Пишем в лог факт, а не адрес: открытый email в журналах не нужен.
RECOVERY_LIMIT_LOG = "Лимит писем восстановления исчерпан"


def identifier_hash(email: str) -> str:
    """SHA-256 нормализованного адреса: в базе нет открытого email."""
    return sha256(normalize_email(email).encode("utf-8")).hexdigest()


def try_consume_request(db: Session, email: str) -> bool:
    """Занять одну попытку отправки на этот адрес.

    `False` — в текущем окне на адрес уже отправлено не меньше
    `RECOVERY_MAX_REQUESTS_PER_HOUR` писем; новая строка при этом не пишется.
    При успехе старые записи этого адреса за пределами окна удаляются, чтобы
    таблица не росла бесконечно.
    """
    digest = identifier_hash(email)
    now = datetime.now(UTC)
    window_start = now - timedelta(minutes=RECOVERY_WINDOW_MINUTES)

    recent = db.scalar(
        select(func.count())
        .select_from(RecoveryRequest)
        .where(
            RecoveryRequest.identifier_hash == digest,
            RecoveryRequest.created_at > window_start,
        )
    )
    if (recent or 0) >= RECOVERY_MAX_REQUESTS_PER_HOUR:
        return False

    db.execute(
        delete(RecoveryRequest).where(
            RecoveryRequest.identifier_hash == digest,
            RecoveryRequest.created_at <= window_start,
        )
    )
    db.add(RecoveryRequest(identifier_hash=digest, created_at=now))
    db.commit()
    return True


def deliver_recovery_email(
    db: Session,
    user: User,
    *,
    kind: str,
    background_tasks: BackgroundTasks,
) -> None:
    """Выпустить новую ссылку и поставить письмо в фон.

    Прежние живые токены пользователя гасим, чтобы рабочей всегда была ровно
    одна ссылка. Текст письма выбирается по `kind`: неактивному кабинету уходит
    письмо активации, активному — письмо восстановления.
    """
    db.execute(
        update(ActivationToken)
        .where(ActivationToken.user_id == user.id, ActivationToken.used_at.is_(None))
        .values(used_at=datetime.now(UTC))
    )
    token = issue_activation_token(db, user.id, kind=kind)
    db.commit()

    send_task = (
        send_activation_email_task if kind == "activation" else send_password_recovery_email_task
    )
    background_tasks.add_task(
        partial(send_task, to=user.email, full_name=user.full_name, token=token)
    )


@router.post(
    "/password-recovery",
    response_model=ResendActivationResponse,
    summary="Отправить письмо для восстановления пароля",
    responses={
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": "Тело запроса не разбирается как JSON",
        },
    },
)
def request_password_recovery(
    payload: RecoveryRequestModel,
    background_tasks: BackgroundTasks,
    db: DbSession,
) -> ResendActivationResponse:
    """Ответ всегда 200: по коду нельзя узнать, зарегистрирована ли почта."""
    user = db.scalar(select(User).where(User.email == normalize_email(payload.email)))

    # Чужой адрес не засоряет счётчик: лимит считаем только для своих пользователей.
    if user is None:
        return ResendActivationResponse(detail=RECOVERY_DETAIL)

    if not try_consume_request(db, payload.email):
        logger.info("%s: %s", RECOVERY_LIMIT_LOG, identifier_hash(payload.email))
        return ResendActivationResponse(detail=RECOVERY_DETAIL)

    deliver_recovery_email(
        db,
        user,
        kind="recovery" if user.is_active else "activation",
        background_tasks=background_tasks,
    )
    return ResendActivationResponse(detail=RECOVERY_DETAIL)
