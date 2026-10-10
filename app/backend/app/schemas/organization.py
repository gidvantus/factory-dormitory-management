"""Чтение и правка организации пользователя.

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
"""

import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 10 или 12 цифр, и ничего кроме.
INN_PATTERN = re.compile(r"^\d{10}$|^\d{12}$")

INN_FORMAT_MESSAGE = "ИНН должен состоять из 10 или 12 цифр"
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


class UpdateOrganizationRequest(BaseModel):
    """Правка организации. Пустой `inn` очищает поле, пустой `name` — ошибка."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=255)
    inn: str | None = Field(default=None, max_length=RAW_MAX_LENGTH)

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


class OrganizationResponse(BaseModel):
    """Организация пользователя. Пустые поля приходят как `null`."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str | None
    inn: str | None
    created_at: datetime
