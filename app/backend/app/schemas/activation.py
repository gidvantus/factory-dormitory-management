"""Схемы активации личного кабинета по ссылке из письма."""

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

# Минимальная длина нового пароля: короче — 422 от валидатора.
MIN_PASSWORD_LENGTH = 8


class ActivationInfoResponse(BaseModel):
    """Что показывает экран активации до ввода пароля."""

    email: EmailStr
    full_name: str
    expires_at: datetime


class ActivateRequest(BaseModel):
    """Новый пароль, который пользователь задаёт по ссылке из письма."""

    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=1024)


class ResendActivationRequest(BaseModel):
    """Повторная отправка письма: тело — только почта."""

    email: EmailStr


class RecoveryRequestModel(BaseModel):
    """Запрос письма для восстановления пароля: тело — только почта."""

    email: EmailStr


class ResendActivationResponse(BaseModel):
    """Ответ повторной отправки. Всегда одинаковый из-за защиты от перебора адресов."""

    detail: str
