"""Чтение и правка организации пользователя, участники и их приглашение.

Название и ИНН у только что созданной организации пустые — это нормальное
состояние пустой заготовки, а не незаполненная форма.

* `name` необязателен, но если пришёл — он должен быть непустым после
  схлопывания пробелов. Пустая строка и строка из одних пробелов — это 422, а
  не очистка поля: название организации пустым быть не может. Поэтому значение
  приходит как `object` и нормализуется в `mode="before"`, чтобы ограничение
  длины проверяло уже схлопнутое название.
* `inn` необязателен, и пустое значение здесь означает очистку поля (`NULL`).
  Непустое — ровно 10 или 12 цифр: 10 у организации, 12 у индивидуального
  предпринимателя. Буквы и другая длина — 422.
* `kpp`, `ogrn` и `address` заполняются из DaData по ИНН, но приходят и в теле
  правки: пустое значение — очистка поля, как у `inn`. Длины ограничены
  колонками `organizations`.
"""

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.schemas.user import normalize_full_name

# 10 или 12 цифр, и ничего кроме.
INN_PATTERN = re.compile(r"^\d{10}$|^\d{12}$")

INN_FORMAT_MESSAGE = "ИНН должен состоять из 10 или 12 цифр"
REQUISITE_FORMAT_MESSAGE = "Реквизит должен быть строкой"
NAME_REQUIRED_MESSAGE = "Название не может быть пустым"
NAME_TOO_LONG_MESSAGE = "Название не длиннее 255 символов"
NAME_INVALID_MESSAGE = "Название содержит недопустимый символ"

# Потолок на сырое значение до нормализации: защищает от гигантских строк.
RAW_MAX_LENGTH = 4096


def normalize_name(value: Any) -> str:
    """Схлопнуть пробелы. Пустое значение — ошибка: название обязательно."""
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError(NAME_INVALID_MESSAGE)
    collapsed = " ".join(value.split())
    if not collapsed:
        raise ValueError(NAME_REQUIRED_MESSAGE)
    return collapsed


def normalize_inn(value: Any) -> str | None:
    """Проверить ИНН по формату. Пустое значение — очистка поля."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(INN_FORMAT_MESSAGE)
    stripped = value.strip()
    if not stripped:
        return None
    if not INN_PATTERN.match(stripped):
        raise ValueError(INN_FORMAT_MESSAGE)
    return stripped


def normalize_requisite(value: Any) -> str | None:
    """Реквизит из DaData: пробелы по краям отбрасываются, пустое — очистка.

    Пустое значение здесь означает очистку поля, как у `inn`: реквизиты
    необязательны, а у индивидуального предпринимателя КПП не бывает вовсе.
    Длину проверяет `Field(max_length=…)` уже по схлопнутому значению.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(REQUISITE_FORMAT_MESSAGE)
    stripped = value.strip()
    return stripped or None


class UpdateOrganizationRequest(BaseModel):
    """Правка организации. Пустой `inn` очищает поле, пустой `name` — ошибка."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=255)
    inn: str | None = Field(default=None, max_length=RAW_MAX_LENGTH)
    # Реквизиты, заполняемые из DaData. Пустое значение — очистка поля.
    kpp: str | None = Field(default=None, max_length=9)
    ogrn: str | None = Field(default=None, max_length=15)
    address: str | None = Field(default=None, max_length=500)

    @field_validator("name", mode="before")
    @classmethod
    def validate_name(cls, value: Any) -> str | None:
        # Поля нет в теле — название не меняем вовсе.
        if value is None:
            return None
        return normalize_name(value)

    @field_validator("inn", mode="before")
    @classmethod
    def validate_inn(cls, value: Any) -> str | None:
        return normalize_inn(value)

    @field_validator("kpp", "ogrn", "address", mode="before")
    @classmethod
    def validate_requisite(cls, value: Any) -> str | None:
        return normalize_requisite(value)


class OrganizationResponse(BaseModel):
    """Организация пользователя. Пустые поля приходят как `null`."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str | None
    inn: str | None
    kpp: str | None
    ogrn: str | None
    address: str | None
    created_at: datetime


class OrganizationLookupDetails(BaseModel):
    """Реквизиты, найденные в DaData по ИНН. Пустое поле — `null`."""

    name: str | None
    kpp: str | None
    ogrn: str | None
    address: str | None


class OrganizationLookupResponse(BaseModel):
    """Результат поиска организации по ИНН.

    `found: false` — не ошибка: форма не блокируется. `reason` различает
    «по этому ИНН ничего не найдено» (`not_found`), «сервис проверки
    недоступен» (`unavailable`) и «ИНН уже занят другой организацией»
    (`inn_taken`), чтобы пользователь видел разные тексты. Занятый ИНН — не
    про DaData: его находит проверка по своей базе, а `details` тогда пустые.
    """

    found: bool
    reason: Literal["not_found", "unavailable", "inn_taken"] | None
    details: OrganizationLookupDetails | None


# Роли, которые выдаёт приглашение. `owner` сюда не входит — он у организации
# один и появляется при активации кабинета, а `member` — устаревшее значение,
# которое осталось в базе только ради строк, заведённых прежними версиями.
InviteRole = Literal["admin", "manager", "commandant"]


class InviteMemberRequest(BaseModel):
    """Приглашение сотрудника: email, ФИО и роль в организации."""

    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    full_name: str = Field(min_length=1, max_length=255)
    role: InviteRole

    @field_validator("full_name")
    @classmethod
    def validate_full_name(cls, value: str) -> str:
        # Те же правила, что у регистрации: пробелы схлопываются, пустое — 422.
        return normalize_full_name(value)


class OrganizationMemberResponse(BaseModel):
    """Участник организации: строка членства плюс данные его учётной записи.

    `is_active: false` — приглашение отправлено, но человек по ссылке из письма
    ещё не пришёл и пароль не задал. `id` — идентификатор строки членства, а не
    пользователя: в списке участников важно именно место человека в организации.
    """

    id: int
    email: EmailStr
    full_name: str
    role: str
    is_active: bool
    created_at: datetime
