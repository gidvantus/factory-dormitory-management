"""Схемы активации личного кабинета по ссылке из письма."""

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

# Минимальная длина нового пароля: короче — 422 от валидатора.
MIN_PASSWORD_LENGTH = 8


class ActivationInfoResponse(BaseModel):
    """Что показывает экран активации до ввода пароля.

    Два независимых флага, по одному на документ: `consent_required` — «согласия
    ещё нет» (`users.consent_at is NULL`), `terms_required` — «правила не
    приняты» (`users.terms_accepted_at is NULL`). Приглашённый сотрудник
    регистрацию не проходил, поэтому оба чекбокса ему нужны; зарегистрировавшемуся
    через форму второй раз их не показывают — он отметил оба на регистрации.

    Флаги считаются по своим колонкам, а не по одной: пользователь мог пройти
    регистрацию до появления правил и тогда увидит только второй чекбокс.
    """

    email: EmailStr
    full_name: str
    expires_at: datetime
    consent_required: bool
    terms_required: bool


class ActivateRequest(BaseModel):
    """Новый пароль, который пользователь задаёт по ссылке из письма.

    `consent` и `terms_accepted` по умолчанию `False`: у аккаунта, который уже
    дал согласие и принял правила при регистрации, этих полей в теле нет, и это
    не ошибка. Отсутствие отметки у пользователя, у которого документа в базе
    нет, роут проверяет сам — по строке в базе: `consent_at` и
    `terms_accepted_at`.
    """

    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=1024)
    consent: bool = False
    terms_accepted: bool = False


class ResendActivationRequest(BaseModel):
    """Повторная отправка письма: тело — только почта."""

    email: EmailStr


class RecoveryRequestModel(BaseModel):
    """Запрос письма для восстановления пароля: тело — только почта."""

    email: EmailStr


class ResendActivationResponse(BaseModel):
    """Ответ повторной отправки. Всегда одинаковый из-за защиты от перебора адресов."""

    detail: str
