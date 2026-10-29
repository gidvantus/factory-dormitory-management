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
from secrets import compare_digest, token_urlsafe
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, Request, status
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError
from pwdlib.hashers.argon2 import Argon2Hasher
from sqlalchemy.orm import Session

from app import audit
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


def issue_activation_token(db: Session, user_id: int, *, kind: str = "activation") -> str:
    """Выпустить одноразовую ссылку: открытый токен возвращается, в базу идёт хеш.

    `kind` различает письмо активации и письмо восстановления пароля: по нему
    потом видно, откуда пришла ссылка, хотя экран смены пароля у них общий.

    Коммитит вызывающий: регистрация сохраняет пользователя и токен вместе,
    а повторная отправка — пометку старых токенов и новый одним коммитом.
    """
    token = token_urlsafe(ACTIVATION_TOKEN_BYTES)
    db.add(
        ActivationToken(
            user_id=user_id,
            kind=kind,
            token_hash=hash_activation_token(token),
            expires_at=activation_expires_at(),
        )
    )
    return token


def session_user(request: Request, db: Session) -> User | None:
    """Пользователь из cookie сессии или `None`. Единственное чтение сессии.

    Здесь живёт вся политика аутентификации: откуда берётся токен, как он
    разбирается, какой claim считается субъектом и что значит «пользователя
    нет». И `get_current_user`, и `get_optional_user` вызывают этот помощник —
    поэтому новая проверка (отзыв токена, версия, дополнительный claim)
    появляется в одном месте и действует сразу и на кабинет, и на раздачу
    файлов. Двух копий этой политики быть не должно: раздача файлов — маршрут,
    который отдаёт файлы, и отставшее правило пускало бы по старому.
    """
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        return None

    payload = decode_access_token(token)
    if payload is None:
        return None

    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject.isdigit():
        return None

    return db.get(User, int(subject))


def get_current_user(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    """Текущий пользователь из cookie сессии.

    Неактивный пользователь здесь проходит: он должен дойти до экрана
    активации, а не получить 401 «нет сессии». Рабочие ручки закрывает
    `require_active_user`.
    """
    user = session_user(request, db)
    if user is None:
        raise unauthorized()

    # Аутентификация — единственное место, где пользователь становится известен,
    # поэтому актор для журнала действий дописывается здесь. Запись идёт в общий
    # объект контекста запроса (`app.audit`): синхронная зависимость выполняется
    # в threadpool, где доступна мутация объекта, но не установка `ContextVar`.
    # ФИО передаётся снимком: строка журнала сохраняет копию на момент действия,
    # а не ссылку на `users`, которая дала бы текущее имя при чтении.
    audit.record_actor(user.id, user.active_organization_id, user.full_name)

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


def get_optional_user(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> User | None:
    """Пользователь из cookie сессии или `None`, если сессии нет.

    Для раздачи файлов (`/uploads/{key}`): ссылку открывает браузер, и «сессии
    нет» — это не ошибка клиента, а аноним, которому файл закрыт. Поэтому здесь
    нет ни 401, ни `WWW-Authenticate`, в отличие от `get_current_user`. Само
    чтение сессии — то же самое (`session_user`), а не его копия.

    Актором журнала действий пользователь здесь **не становится**: скачивание
    файла — чтение, а не действие кабинета, и записывать его в журнал от имени
    пользователя незачем (иначе каждая ссылка из письма была бы строкой журнала).
    """
    return session_user(request, db)


# Тот же пользователь, но «может быть анонимом»: значение `None` — нормальный
# результат, а не ошибка.
OptionalUser = Annotated[User | None, Depends(get_optional_user)]

# Единое описание этого 403 для `responses=` рабочих роутеров.
ACTIVE_USER_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_403_FORBIDDEN: {
        "model": ErrorResponse,
        "description": ACTIVATION_REQUIRED_DETAIL,
    }
}

# Заголовок, которым бот доказывает CRM, что он бот. Не cookie: бот не человек и
# сессии у него нет.
BOT_TOKEN_HEADER = "X-Bot-Token"

# Единый текст 401 для роутов бота. Точная причина отказа не называется: иначе по
# ответу можно было бы отличить «нет заголовка» от «неверный токен».
INVALID_BOT_TOKEN_DETAIL = "Неверный сервисный токен"


def require_service_bot(request: Request) -> None:
    """Пропустить только бота: заголовок `X-Bot-Token` сверяется с секретом.

    Секрет приходит из окружения (`TELEGRAM_SERVICE_TOKEN`) и не является токеном
    BotFather. Сравнение — в постоянном времени (`secrets.compare_digest`), а
    неверный токен не пишется в лог: иначе значение секрета попало бы в логи
    поддержки. Пустой настроенный секрет закрывает роуты целиком: без него
    отличить бота от постороннего нельзя.
    """
    settings = get_settings()
    expected = settings.telegram_service_token
    provided = request.headers.get(BOT_TOKEN_HEADER, "")
    if not expected or not provided or not compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=INVALID_BOT_TOKEN_DETAIL,
        )


# Зависимость роутов бота: работает как «пропуск», значение не нужно.
ServiceBot = Annotated[None, Depends(require_service_bot)]
