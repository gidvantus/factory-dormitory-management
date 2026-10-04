"""Пароли и сессии.

Здесь собрано всё, что относится к аутентификации: генерация и хеширование
пароля, выпуск и разбор JWT, cookie сессии и зависимость, достающая текущего
пользователя. Роуты и экраны не знают, как именно устроен токен, поэтому слой
можно заменить (например, на внешний OIDC), не трогая их.
"""

import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError
from pwdlib.hashers.argon2 import Argon2Hasher
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models.user import User

# Длина пароля, который сервер выдаёт пользователю (в символах, не в байтах).
GENERATED_PASSWORD_BYTES = 12

# Единственный экземпляр хешера: argon2 сам держит параметры и соль.
_password_hash = PasswordHash((Argon2Hasher(),))


def generate_password() -> str:
    """Открытый пароль показывается пользователю ровно один раз."""
    return secrets.token_urlsafe(GENERATED_PASSWORD_BYTES)


def hash_password(password: str) -> str:
    """argon2-хеш для хранения в базе."""
    return _password_hash.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Проверка пароля. argon2 сравнивает хеши в постоянном времени."""
    try:
        return _password_hash.verify(password, password_hash)
    except UnknownHashError:
        # Испорченный или чужой формат хеша — это просто неуспешная проверка.
        return False


def create_access_token(subject: str) -> str:
    """JWT с идентификатором пользователя в `sub`."""
    settings = get_settings()
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": now,
        "exp": now + timedelta(days=settings.jwt_expire_days),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict[str, Any] | None:
    """Разбор токена. Любая проблема (подпись, срок, формат) — это `None`."""
    settings = get_settings()
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError:
        return None


def session_cookie() -> dict[str, Any]:
    """Параметры cookie сессии: httpOnly, SameSite=Lax, срок жизни — как у токена."""
    settings = get_settings()
    return {
        "key": settings.session_cookie_name,
        "httponly": True,
        "samesite": "lax",
        "secure": settings.session_cookie_secure,
        "path": "/",
        "max_age": settings.jwt_expire_days * 24 * 60 * 60,
    }


def expired_session_cookie() -> dict[str, Any]:
    """Те же атрибуты, но без срока: ими cookie удаляется."""
    settings = get_settings()
    return {
        "key": settings.session_cookie_name,
        "httponly": True,
        "samesite": "lax",
        "secure": settings.session_cookie_secure,
        "path": "/",
    }


def unauthorized() -> HTTPException:
    """Один и тот же ответ на «нет cookie», «токен истёк» и «сессии нет в базе»."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Требуется авторизация",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    """Текущий пользователь из cookie сессии."""
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        raise unauthorized()

    payload = decode_access_token(token)
    if payload is None:
        raise unauthorized()

    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject.isdigit():
        raise unauthorized()

    user = db.get(User, int(subject))
    if user is None or not user.is_active:
        raise unauthorized()

    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
