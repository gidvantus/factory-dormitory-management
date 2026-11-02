"""Вход, проверка сессии и выход.

Три ручки и один сессионный токен в httpOnly cookie. Базы и ролей нет: оператор
один, он описан в конфиге, поэтому «вошёл» и «не вошёл» — это наличие и
годность cookie.
"""

from fastapi import APIRouter, HTTPException, Response, status

from app.config import get_settings
from app.schemas import ErrorResponse, LoginRequest, OperatorResponse
from app.security import (
    LOGIN_FAILED_DETAIL,
    UNAUTHORIZED_DETAIL,
    CurrentOperator,
    create_operator_token,
    credentials_match,
    expired_session_cookie,
    session_cookie,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# Описание отказов для схемы: эти два текста и есть контракт с клиентом,
# поэтому они перечислены явно, а не оставлены умолчанию FastAPI.
LOGIN_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": LOGIN_FAILED_DETAIL,
    },
}
ME_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_401_UNAUTHORIZED: {
        "model": ErrorResponse,
        "description": UNAUTHORIZED_DETAIL,
    },
}


@router.post(
    "/login",
    response_model=OperatorResponse,
    summary="Вход по логину и паролю из конфига",
    responses=LOGIN_RESPONSES,
)
def login(payload: LoginRequest, response: Response) -> OperatorResponse:
    """Проверить пару с конфигом и выдать cookie сессии.

    Неверная пара — `401` с одним и тем же текстом для неверного логина и
    неверного пароля. Пустые строки — тоже `401` (это неверная пара), а не
    `422`: проверка обязательности полей прошла, проверка значения — нет.
    """
    settings = get_settings()
    if not credentials_match(payload.username, payload.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=LOGIN_FAILED_DETAIL)

    token = create_operator_token(settings.operator_username)
    response.set_cookie(value=token, **session_cookie())
    return OperatorResponse(username=settings.operator_username)


@router.get(
    "/me",
    response_model=OperatorResponse,
    summary="Кто вошёл",
    responses=ME_RESPONSES,
)
def me(operator: CurrentOperator) -> OperatorResponse:
    """Логин текущего оператора. Без годной cookie — `401`."""
    return OperatorResponse(username=operator)


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Выход: сессия гасится",
)
def logout(response: Response) -> None:
    """Погасить cookie теми же атрибутами, без срока.

    Без сессии отвечает `204`, а не `401`: выход из уже закрытой сессии — не
    ошибка клиента, повторное нажатие «Выйти» не должно показывать отказ.
    """
    response.delete_cookie(**expired_session_cookie())
