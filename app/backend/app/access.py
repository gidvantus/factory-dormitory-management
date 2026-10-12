"""Проверки доступа, не сводящиеся к аутентификации.

`security.py` отвечает на вопрос «кто это» и «активирован ли кабинет». Здесь
следующий слой: **работает** ли кабинет сейчас — активирован и не закрыт
истёкшим пробным периодом без тарифа.

Две зависимости разделены намеренно. `ActiveUser` пускает любого активированного
пользователя: экран активации, профиль и разделы организации обязаны работать и
на закрытом кабинете. `SubscribedUser` добавляет к этому проверку пробного
периода и стоит только на рабочих разделах.
"""

from typing import Annotated, Any

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.user import User
from app.schemas.user import ErrorResponse
from app.security import ACTIVATION_REQUIRED_DETAIL, ActiveUser
from app.trial import TRIAL_EXPIRED_DETAIL, trial_state

DbSession = Annotated[Session, Depends(get_db)]


def require_subscribed_user(user: ActiveUser, db: DbSession) -> User:
    """Активированный пользователь с работающим кабинетом. Иначе — 403.

    Порядок проверок важен: неактивированный получает **свой** текст
    «Активируйте личный кабинет» (`require_active_user` идёт первым), и только
    активированный, но закрытый кабинет — текст про выбор тарифа.
    """
    if trial_state(db, user).locked:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=TRIAL_EXPIRED_DETAIL,
        )
    return user


SubscribedUser = Annotated[User, Depends(require_subscribed_user)]

# Единое описание 403 рабочих роутеров: у кода два разных текста, и оба здесь.
SUBSCRIBED_USER_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": (
            f"{ACTIVATION_REQUIRED_DETAIL} — кабинет не активирован; "
            f"{TRIAL_EXPIRED_DETAIL} — пробный период закончился"
        ),
    }
}
