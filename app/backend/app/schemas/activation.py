"""Схемы активации личного кабинета по ссылке из письма."""

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

# Минимальная длина нового пароля: короче — 422 от валидатора.
MIN_PASSWORD_LENGTH = 8


class ActivationInfoResponse(BaseModel):
    """Что показывает экран активации до ввода пароля.

    `consent_required` — «согласия ещё нет» (`users.consent_at is NULL`).
    Приглашённый сотрудник регистрацию не проходил, поэтому чекбокс ему нужен;
    зарегистрировавшемуся через форму второй раз его не показывают.
    """

    email: EmailStr
    full_name: str
    expires_at: datetime
    consent_required: bool


class ActivateRequest(BaseModel):
    """Новый пароль, который пользователь задаёт по ссылке из письма.

    `consent` по умолчанию `False`: у аккаунта, который уже дал согласие при
    регистрации, поля в теле нет, и это не ошибка. Отсутствие согласия у
    пользователя без `consent_at` роут проверяет сам — по строке в базе.
    """

    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=1024)
    consent: bool = False


class ResendActivationRequest(BaseModel):
    """Повторная отправка письма: тело — только почта."""

    email: EmailStr


class RecoveryRequestModel(BaseModel):
    """Запрос письма для восстановления пароля: тело — только почта."""

    email: EmailStr


class ResendActivationResponse(BaseModel):
    """Ответ повторной отправки. Всегда одинаковый из-за защиты от перебора адресов."""

    detail: str
