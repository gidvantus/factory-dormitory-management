"""Схема состояния пробного периода."""

from datetime import datetime

from pydantic import BaseModel


class TrialResponse(BaseModel):
    """Пробный период текущего пользователя.

    Состояние живёт отдельной ручкой, а не в `GET /api/me`: у `UserResponse`
    общий контракт входа, профиля и активации, и расширять его ради данных
    одного экрана не нужно.

    `ends_at` = `None` означает, что пробного периода нет вовсе, а не что он
    ещё не начался. `member_limit` — сколько сотрудников, кроме владельца,
    допускает пробный период; `None` значит «предела нет», и это умолчание:
    клиент не подставляет вместо него своё число, а рисует экран без предела.
    """

    ends_at: datetime | None
    days_left: int
    is_active: bool
    locked: bool
    member_limit: int | None
