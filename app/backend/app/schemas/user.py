"""Схемы запросов и ответов аутентификации."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


def normalize_email(email: str) -> str:
    """Email хранится и сравнивается без учёта регистра."""
    return email.strip().lower()


def normalize_full_name(value: str) -> str:
    """Схлопнуть пробелы в ФИО. Строка из одних пробелов — ошибка.

    Общий помощник регистрации и приглашения сотрудника: ФИО в обоих случаях
    вводит человек, и правила у них одинаковые.
    """
    collapsed = " ".join(value.split())
    if not collapsed:
        raise ValueError("ФИО не может быть пустым")
    return collapsed


class RegisterRequest(BaseModel):
    """Регистрация: пароль придумывает сервер, пользователь вводит только email и ФИО."""

    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)

    @field_validator("full_name")
    @classmethod
    def validate_full_name(cls, value: str) -> str:
        return normalize_full_name(value)


class RegisterResponse(BaseModel):
    """Ответ регистрации: пароль сервер не показывает никогда.

    `activation_email_sent` говорит лишь о том, настроен ли SMTP и есть ли
    шаблон письма: сама отправка идёт фоном после ответа.
    """

    email: EmailStr
    full_name: str
    created_at: datetime
    activation_email_sent: bool


class LoginRequest(BaseModel):
    """Вход. Email здесь обычная строка: неверный формат — тоже просто 401."""

    email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class UserResponse(BaseModel):
    """То, что пользователь вводил сам, плюс признак активации кабинета."""

    model_config = ConfigDict(from_attributes=True)

    email: EmailStr
    full_name: str
    created_at: datetime
    is_active: bool


class ErrorResponse(BaseModel):
    """Тело ошибки, которую роут поднимает сам.

    Нужна не для логики, а для контракта: без неё `HTTPException` в роуте
    возвращает статус, которого нет в опубликованной схеме `/openapi.json`.
    """

    detail: str
