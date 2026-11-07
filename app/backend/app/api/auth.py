"""Регистрация, вход и выход.

Служебный пароль регистрации генерируется на сервере, хешируется и никогда не
покидает его: ни в ответе, ни в логах, ни в письме. Пользователь попадает в
кабинет только по ссылке активации (`app/api/activation.py`), где сам задаёт
новый пароль.

Вход по ссылке поддержки (`POST /auth/impersonate`) живёт здесь же: сессию
ставит только этот API и только на своём origin, а кабинет оператора лишь
выдаёт ссылку на него (`app/api/platform_users.py`).
"""

import secrets
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.platform_users import USER_NOT_FOUND_DETAIL
from app.consent import record_consent, record_terms_acceptance
from app.db import get_db
from app.mail import activation_email_ready, send_activation_email_task
from app.models.user import User
from app.schemas.user import (
    ErrorResponse,
    ImpersonateRequest,
    LoginRequest,
    RegisterRequest,
    RegisterResponse,
    UserResponse,
    normalize_email,
)
from app.security import (
    CABINET_NOT_ACTIVATED_DETAIL,
    IMPERSONATION_LINK_INVALID_DETAIL,
    create_access_token,
    decode_impersonation_token,
    expired_session_cookie,
    hash_password,
    issue_activation_token,
    session_cookie,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

DbSession = Annotated[Session, Depends(get_db)]

# Длина служебного пароля регистрации (в байтах, не в символах).
GENERATED_PASSWORD_BYTES = 12


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    response_model=RegisterResponse,
    summary="Зарегистрировать пользователя и отправить письмо активации",
    responses={
        status.HTTP_400_BAD_REQUEST: {
            "model": ErrorResponse,
            "description": "Тело запроса не разбирается как JSON",
        },
        status.HTTP_409_CONFLICT: {
            "model": ErrorResponse,
            "description": "Email уже занят",
        },
        status.HTTP_422_UNPROCESSABLE_ENTITY: {
            "model": ErrorResponse,
            "description": (
                "Неверный email, пустое ФИО, нет согласия на обработку данных "
                "или не приняты правила использования платформой"
            ),
        },
    },
)
def register(
    payload: RegisterRequest,
    background_tasks: BackgroundTasks,
    db: DbSession,
) -> RegisterResponse:
    email = normalize_email(payload.email)

    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Пользователь с таким email уже зарегистрирован",
        )

    # Пароль нужен только чтобы неактивный аккаунт не остался без хеша:
    # пользователю он не показывается, а при активации заменяется на новый.
    user = User(
        email=email,
        full_name=payload.full_name,
        password_hash=hash_password(secrets.token_urlsafe(GENERATED_PASSWORD_BYTES)),
        is_active=False,
    )
    # Согласие и принятие правил пишутся в той же транзакции, что и сам
    # пользователь: отказ на уникальном индексе не должен оставить отметки без
    # пользователя. Это два разных документа — две пары колонок.
    record_consent(db, user)
    record_terms_acceptance(db, user)
    db.add(user)
    try:
        db.flush()
        token = issue_activation_token(db, user.id)
        db.commit()
    except IntegrityError:
        # Две одновременные регистрации на один email: уникальный индекс сработал.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Пользователь с таким email уже зарегистрирован",
        ) from None
    db.refresh(user)

    background_tasks.add_task(
        send_activation_email_task,
        to=user.email,
        full_name=user.full_name,
        token=token,
    )

    return RegisterResponse(
        email=user.email,
        full_name=user.full_name,
        created_at=user.created_at,
        activation_email_sent=activation_email_ready(db),
    )


@router.post(
    "/login",
    response_model=UserResponse,
    summary="Войти по email и паролю",
    responses={
        status.HTTP_400_BAD_REQUEST: {
            "model": ErrorResponse,
            "description": "Тело запроса не разбирается как JSON",
        },
        status.HTTP_401_UNAUTHORIZED: {
            "model": ErrorResponse,
            "description": "Неверный email или пароль",
        },
    },
)
def login(payload: LoginRequest, response: Response, db: DbSession) -> UserResponse:
    email = normalize_email(payload.email)
    user = db.scalar(select(User).where(User.email == email))

    # Ответ одинаковый и для несуществующего email, и для неверного пароля.
    password_matches = user is not None and verify_password(payload.password, user.password_hash)
    if user is None or not password_matches:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный email или пароль",
        )

    # Неактивный вход разрешён: сессия нужна, чтобы фронт увидел `is_active: false`
    # и увёл на экран активации. Рабочие ручки закрыты `ActiveUser` и отвечают 403.
    response.set_cookie(value=create_access_token(str(user.id)), **session_cookie())
    return UserResponse.model_validate(user)


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Выйти и погасить cookie сессии",
)
def logout() -> Response:
    """Выход: гасим cookie сессии. Тела у ответа нет."""
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(**expired_session_cookie())
    return response


IMPERSONATE_RESPONSES: dict[int | str, dict[str, object]] = {
    status.HTTP_400_BAD_REQUEST: {
        "model": ErrorResponse,
        # Два случая у одного кода, как у `register` и `login`: текст про саму
        # ссылку и отказ Starlette на тело, которое не разбирается как JSON.
        "description": (
            f"{IMPERSONATION_LINK_INVALID_DETAIL} или тело запроса не разбирается как JSON"
        ),
    },
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": USER_NOT_FOUND_DETAIL,
    },
    status.HTTP_409_CONFLICT: {
        "model": ErrorResponse,
        "description": CABINET_NOT_ACTIVATED_DETAIL,
    },
    status.HTTP_422_UNPROCESSABLE_ENTITY: {
        "model": ErrorResponse,
        "description": "Токена нет, он пустой или в теле есть лишнее поле",
    },
}


@router.post(
    "/impersonate",
    response_model=UserResponse,
    summary="Войти под пользователем по ссылке поддержки",
    responses=IMPERSONATE_RESPONSES,
)
def impersonate(payload: ImpersonateRequest, response: Response, db: DbSession) -> UserResponse:
    """Вход по одноразовой ссылке кабинета оператора.

    Cookie сессии ставит только этот API и только на своём origin: у кабинета
    оператора своя cookie (`operator_session`), и браузер оператора приходит сюда
    по адресу сайта. Сессия выпускается обычная, но с признаком `imp`: по нему
    журнал действий молчит, а правила уведомлений не рассылают. Тело ответа — то
    же, что у `POST /api/auth/login`.

    Первым разбирается токен: битая подпись, истёкший срок, чужой claim и не тот
    вид токена (ссылка, а не сессия) — один и тот же `400`, и до базы такой
    запрос не доходит. Дальше отказы те же, что у выдачи ссылки: пользователя
    нет — `404`, кабинет не активирован — `409`.
    """
    user_id = decode_impersonation_token(payload.token)
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=IMPERSONATION_LINK_INVALID_DETAIL,
        )

    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=USER_NOT_FOUND_DETAIL)
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=CABINET_NOT_ACTIVATED_DETAIL,
        )

    response.set_cookie(
        value=create_access_token(str(user.id), impersonated=True), **session_cookie()
    )
    return UserResponse.model_validate(user)
