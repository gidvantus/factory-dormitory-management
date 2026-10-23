"""Схемы запросов и ответов аутентификации."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.consent import CONSENT_REQUIRED_DETAIL, TERMS_REQUIRED_DETAIL


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
    """Регистрация: пароль придумывает сервер, пользователь вводит email, ФИО и две отметки.

    `consent` и `terms_accepted` обязательны и без значений по умолчанию: клиент
    обязан прислать их явно, а `false` — не «поле не пришло», а осознанный отказ,
    который так же ведёт к 422. Без этого старый клиент зарегистрировал бы
    пользователя без согласия или без принятия правил.

    Это два разных документа, поэтому и отказа два: согласие на обработку
    персональных данных и принятие правил использования платформой. Тексты
    отказов разные — человек читает их под своим чекбоксом.
    """

    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)
    consent: bool
    terms_accepted: bool

    @field_validator("full_name")
    @classmethod
    def validate_full_name(cls, value: str) -> str:
        return normalize_full_name(value)

    @model_validator(mode="before")
    @classmethod
    def require_consents(cls, data: Any) -> Any:
        """422 с текстом про отметку и когда она не отмечена, и когда поля нет.

        Проверка стоит до разбора полей: на пропущенное обязательное поле
        pydantic отвечает своим «Field required», а человеку под чекбоксом нужен
        текст про документ — тот же, что и при явном `false`.

        Отметки проверяются по очереди, согласие первым: 422 несёт один текст, и
        порядок «сначала согласие» сохраняет прежнее поведение для запросов, где
        не отмечено ни то, ни другое.
        """
        if isinstance(data, dict):
            if not data.get("consent"):
                raise ValueError(CONSENT_REQUIRED_DETAIL)
            if not data.get("terms_accepted"):
                raise ValueError(TERMS_REQUIRED_DETAIL)
        return data

    @field_validator("consent")
    @classmethod
    def validate_consent(cls, value: bool) -> bool:
        """Ложь после приведения типов — тоже отказ.

        `consent: "false"` проходит первую проверку (непустая строка — истина),
        а `bool` приводит её к `False`: без этого валидатора согласие
        записалось бы по строке, которая означает отказ.
        """
        if not value:
            raise ValueError(CONSENT_REQUIRED_DETAIL)
        return value

    @field_validator("terms_accepted")
    @classmethod
    def validate_terms_accepted(cls, value: bool) -> bool:
        """Та же защита, что у согласия: строка «false» — осознанный отказ.

        Без этого валидатора `terms_accepted: "false"` записал бы принятие
        правил по строке, которая означает обратное.
        """
        if not value:
            raise ValueError(TERMS_REQUIRED_DETAIL)
        return value


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


class MeResponse(UserResponse):
    """Профиль текущего пользователя вместе с ролью в организации.

    Отдельная схема, а не поле в `UserResponse`: та обслуживает ещё вход,
    регистрацию и активацию, и роль в их ответах была бы лишней. Здесь же она
    нужна кабинету — по ней фронт решает, показывать ли разделы уровня
    владельца (журнал действий).

    `role` = `None` означает, что организации (или строки членства в ней) у
    пользователя нет: так выглядит и неактивированный кабинет. Значения роли —
    `ORGANIZATION_ROLES` (`app.models.organization`), за их подстановку отвечает
    не схема, а база.
    """

    role: str | None


class ErrorResponse(BaseModel):
    """Тело ошибки, которую роут поднимает сам.

    Нужна не для логики, а для контракта: без неё `HTTPException` в роуте
    возвращает статус, которого нет в опубликованной схеме `/openapi.json`.
    """

    detail: str
