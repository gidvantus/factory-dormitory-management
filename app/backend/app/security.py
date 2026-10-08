"""Пароли и сессии.

Здесь собрано всё, что относится к аутентификации: хеширование и проверка
пароля, выпуск и разбор JWT, cookie сессии и зависимости, достающие текущего
пользователя. Роуты и экраны не знают, как именно устроен токен, поэтому слой
можно заменить (например, на внешний OIDC), не трогая их.

Две зависимости разделены по смыслу: `CurrentUser` — «кто это», `ActiveUser` —
«кто это и кабинет активирован». Неактивному доступна только активация.
"""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from secrets import token_urlsafe
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError
from pwdlib.hashers.argon2 import Argon2Hasher
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models.activation import ActivationToken
from app.models.user import User
from app.schemas.user import ErrorResponse

# Длина открытого токена активации: 32 байта энтропии подобрать нельзя.
ACTIVATION_TOKEN_BYTES = 32

# Единственный экземпляр хешера: argon2 сам держит параметры и соль.
_password_hash = PasswordHash((Argon2Hasher(),))


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


def hash_activation_token(token: str) -> str:
    """Хеш токена для базы: утечка строки не даёт активировать чужой кабинет."""
    return sha256(token.encode("utf-8")).hexdigest()


def activation_expires_at(now: datetime | None = None) -> datetime:
    """Момент, до которого ссылка активации живёт."""
    return (now or datetime.now(UTC)) + timedelta(hours=get_settings().activation_token_ttl_hours)


def issue_activation_token(db: Session, user_id: int) -> str:
    """Выпустить одноразовую ссылку: открытый токен возвращается, в базу идёт хеш.

    Коммитит вызывающий: регистрация сохраняет пользователя и токен вместе,
    а повторная отправка — пометку старых токенов и новый одним коммитом.
    """
    token = token_urlsafe(ACTIVATION_TOKEN_BYTES)
    db.add(
        ActivationToken(
            user_id=user_id,
            token_hash=hash_activation_token(token),
            expires_at=activation_expires_at(),
        )
    )
    return token


def get_current_user(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    """Текущий пользователь из cookie сессии.

    Неактивный пользователь здесь проходит: он должен дойти до экрана
    активации, а не получить 401 «нет сессии». Рабочие ручки закрывает
    `require_active_user`.
    """
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
    if user is None:
        raise unauthorized()

    return user


# Текст 403 дословно совпадает с тем, что показывает фронт на экране активации.
ACTIVATION_REQUIRED_DETAIL = "Активируйте личный кабинет"

CurrentUser = Annotated[User, Depends(get_current_user)]


def require_active_user(user: CurrentUser) -> User:
    """Тот же пользователь, но с активированным кабинетом. Иначе — 403."""
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=ACTIVATION_REQUIRED_DETAIL,
        )
    return user


ActiveUser = Annotated[User, Depends(require_active_user)]

# Единое описание этого 403 для `responses=` рабочих роутеров.
ACTIVE_USER_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": ACTIVATION_REQUIRED_DETAIL,
    }
}
