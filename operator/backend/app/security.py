"""Пароль оператора, токен сессии и cookie.

Здесь собрано всё, что относится ко входу: сверка пары «логин — пароль» с
конфигом, выпуск и разбор JWT, cookie сессии и зависимость «текущий оператор».
Ручки и экраны не знают, как устроен токен, поэтому слой можно заменить, не
трогая их.

Базы у кабинета нет: оператор один, и он описан в конфиге. Поэтому проверка
пароля — это сравнение с настройкой в постоянном времени, а не argon2: хеша
пароля в репозитории нет, пароль живёт только в `.env` стенда.
"""

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from hmac import compare_digest
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Request, status

from app.config import get_settings

# Один и тот же текст на «нет такого логина» и «не тот пароль»: иначе форма
# входа превращается в подсказку, какие логины существуют.
LOGIN_FAILED_DETAIL = "Неверный логин или пароль"
UNAUTHORIZED_DETAIL = "Требуется авторизация"


def credentials_match(username: str, password: str) -> bool:
    """Пара совпадает с конфигом.

    Оба значения сравниваются побайтово (`hmac.compare_digest` на UTF-8 байтах):
    в постоянном времени и без ограничения на ASCII — логин оператора может быть
    не-ASCII. Сравнения выполняются оба, чтобы по времени ответа нельзя было
    понять, какая половина пары не подошла.
    """
    settings = get_settings()
    username_ok = compare_digest(
        username.encode("utf-8"),
        settings.operator_username.encode("utf-8"),
    )
    password_ok = compare_digest(
        password.encode("utf-8"),
        settings.operator_password.encode("utf-8"),
    )
    return username_ok and password_ok


def create_operator_token(username: str) -> str:
    """JWT сессии: `sub` — логин, `iat` — выпуск, `exp` — конец срока."""
    settings = get_settings()
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": username,
        "iat": now,
        "exp": now + timedelta(hours=settings.operator_token_ttl_hours),
    }
    return jwt.encode(
        payload,
        settings.operator_token_secret,
        algorithm=settings.operator_token_algorithm,
    )


def decode_operator_token(token: str) -> str | None:
    """Логин из токена. Любая проблема (подпись, срок, формат) — это `None`, не `500`."""
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.operator_token_secret,
            algorithms=[settings.operator_token_algorithm],
        )
    except jwt.PyJWTError:
        return None
    subject = payload.get("sub")
    # Токен, подписанный нашим секретом, но выпущенный не тому оператору, —
    # тоже «нет сессии»: имя оператора берётся из конфига, а не из токена.
    if not isinstance(subject, str) or subject != settings.operator_username:
        return None
    return subject


def session_cookie() -> dict[str, Any]:
    """Параметры cookie сессии: httpOnly, SameSite=Lax, срок жизни — как у токена."""
    settings = get_settings()
    return {
        "key": settings.operator_session_cookie_name,
        "httponly": True,
        "samesite": "lax",
        "secure": settings.operator_session_cookie_secure,
        "path": "/",
        "max_age": settings.operator_token_ttl_seconds,
    }


def expired_session_cookie() -> dict[str, Any]:
    """Те же атрибуты, но без срока: ими cookie удаляется."""
    settings = get_settings()
    return {
        "key": settings.operator_session_cookie_name,
        "httponly": True,
        "samesite": "lax",
        "secure": settings.operator_session_cookie_secure,
        "path": "/",
    }


def unauthorized() -> HTTPException:
    """Один и тот же ответ на «нет cookie», «истёк срок» и «токен не разобрался»."""
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=UNAUTHORIZED_DETAIL)


def operator_from_cookies(cookies: Mapping[str, str]) -> str | None:
    """Логин из cookie сессии или `None`, если сессии нет."""
    token = cookies.get(get_settings().operator_session_cookie_name)
    if not token:
        return None
    return decode_operator_token(token)


def current_operator(request: Request) -> str:
    """Зависимость «кто вошёл»: логин оператора или `401`.

    Cookie читается из запроса, а не из заголовка `Authorization`: токен живёт
    только в httpOnly cookie, и JavaScript его не видит.
    """
    username = operator_from_cookies(request.cookies)
    if username is None:
        raise unauthorized()
    return username


# Зависимость в том виде, в каком её используют ручки: `operator: CurrentOperator`.
CurrentOperator = Annotated[str, Depends(current_operator)]
