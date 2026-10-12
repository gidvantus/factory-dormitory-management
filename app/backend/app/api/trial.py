"""Состояние пробного периода текущего пользователя.

Ручка отвечает и на закрытом кабинете: без неё фронт не узнал бы, что кабинет
закрыт, и не смог бы перенаправить пользователя на список тарифов. Поэтому
зависимость здесь `ActiveUser`, а не `SubscribedUser`: неактивированный кабинет
получает свой 403 «Активируйте личный кабинет».
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas.trial import TrialResponse
from app.schemas.user import ErrorResponse
from app.security import ACTIVE_USER_RESPONSES, ActiveUser
from app.trial import trial_state

router = APIRouter(
    prefix="/trial",
    tags=["trial"],
    responses={
        401: {"model": ErrorResponse, "description": "Требуется авторизация"},
        **ACTIVE_USER_RESPONSES,
    },
)
DbSession = Annotated[Session, Depends(get_db)]


@router.get("", response_model=TrialResponse, summary="Пробный период кабинета")
def read_trial(user: ActiveUser, db: DbSession) -> TrialResponse:
    """Сколько дней осталось и закрыт ли кабинет."""
    state = trial_state(db, user)
    return TrialResponse(
        ends_at=state.ends_at,
        days_left=state.days_left,
        is_active=state.is_active,
        locked=state.locked,
        member_limit=state.member_limit,
    )
