"""Схемы запросов и ответов аутентификации."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


def normalize_email(email: str) -> str:
    """Email хранится и сравнивается без учёта регистра."""
    return email.strip().lower()


class RegisterRequest(BaseModel):
    """Регистрация: пароль придумывает сервер, пользователь вводит только email и ФИО."""

    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)

    @field_validator("full_name")
    @classmethod
    def normalize_full_name(cls, value: str) -> str:
        collapsed = " ".join(value.split())
        if not collapsed:
            raise ValueError("ФИО не может быть пустым")
        return collapsed


class RegisterResponse(BaseModel):
    """Единственный ответ, в котором есть открытый пароль."""

    email: EmailStr
    full_name: str
    password: str
    created_at: datetime


class LoginRequest(BaseModel):
    """Вход. Email здесь обычная строка: неверный формат — тоже просто 401."""

    email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class UserResponse(BaseModel):
    """То, что пользователь вводил сам: почта и ФИО."""

    model_config = ConfigDict(from_attributes=True)

    email: EmailStr
    full_name: str
    created_at: datetime
