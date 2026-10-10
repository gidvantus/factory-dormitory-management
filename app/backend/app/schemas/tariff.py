"""Схемы тарифов: создание, частичная правка и ответ публичной страницы.

Правила полей вынесены в модульные функции, чтобы создание и правка проверяли
одно и то же одинаково: расхождение между `POST` и `PATCH` — самая частая
причина, по которой одно и то же значение проходит в одном месте и падает в
другом.

Разница между запросами только в обязательности: на создании `name` и `amount`
нужны всегда, на правке любое поле можно не присылать. Но `null` для полей,
которые в базе `NOT NULL` (`name`, `amount`, `currency`, `period`, `is_visible`),
означает не «не менять», а ошибку: превращать `"amount": null` в «оставить
прежнюю сумму» — молчаливая потеря намерения клиента. У `description` и
`unit_label`, наоборот, `null` — это очистка поля, потому что в базе они nullable.

Сумма едет по JSON строкой (`Numeric` → `"5000.00"`), поэтому тип `Decimal`, а не
`float`: копейки не должны теряться на округлении.
"""

import re
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.tariff import MAX_TARIFF_AMOUNT

# Периоды списания — те же три, что разрешает `CHECK` в таблице.
TariffPeriod = Literal["month", "year", "once"]

NAME_MAX_LENGTH = 120
DESCRIPTION_MAX_LENGTH = 2000
UNIT_LABEL_MAX_LENGTH = 40

# Ровно три заглавные латинские буквы: код валюты по ISO 4217.
CURRENCY_PATTERN = re.compile(r"^[A-Z]{3}$")

NAME_INVALID_MESSAGE = "Название содержит недопустимый символ"
NAME_REQUIRED_MESSAGE = "Название не может быть пустым"
DESCRIPTION_TOO_LONG_MESSAGE = f"Описание не длиннее {DESCRIPTION_MAX_LENGTH} символов"
UNIT_LABEL_TOO_LONG_MESSAGE = f"Уточнение «за что» не длиннее {UNIT_LABEL_MAX_LENGTH} символов"
AMOUNT_PRECISION_MESSAGE = "Сумма указывается не более чем с двумя знаками после запятой"
CURRENCY_FORMAT_MESSAGE = "Код валюты — три заглавные латинские буквы"
CLEARING_FORBIDDEN_MESSAGE = "Поле нельзя очистить"

# Поля, которые в базе `NOT NULL`: `null` в них — ошибка, а не «не менять».
NON_NULLABLE_FIELDS = ("name", "amount", "currency", "period", "is_visible")


def normalize_name(value: Any) -> str | None:
    """Обрезка пробелов и запрет `\\x00`. Пустое название — ошибка."""
    if value is None:
        return None
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError(NAME_INVALID_MESSAGE)
    stripped = value.strip()
    if not stripped:
        raise ValueError(NAME_REQUIRED_MESSAGE)
    return stripped


def normalize_optional_text(value: Any, max_length: int, too_long_message: str) -> str | None:
    """Необязательное уточнение. Пустая строка — это отсутствие уточнения (`None`)."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(too_long_message)
    stripped = value.strip()
    if not stripped:
        return None
    if len(stripped) > max_length:
        raise ValueError(too_long_message)
    return stripped


def normalize_currency(value: Any) -> str | None:
    """Код валюты целиком в верхнем регистре: «rub» — ошибка, а не «RUB»."""
    if value is None:
        return None
    if not isinstance(value, str) or not CURRENCY_PATTERN.match(value):
        raise ValueError(CURRENCY_FORMAT_MESSAGE)
    return value


def check_amount_precision(value: Decimal | None) -> Decimal | None:
    """Больше двух знаков после запятой — ошибка, а не тихое округление."""
    if value is None:
        return None
    if value != value.quantize(Decimal("0.01")):
        raise ValueError(AMOUNT_PRECISION_MESSAGE)
    return value


class CreateTariffRequest(BaseModel):
    """Новый тариф прайса."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=NAME_MAX_LENGTH)
    description: str | None = None
    amount: Decimal = Field(ge=0, le=MAX_TARIFF_AMOUNT)
    currency: str = "RUB"
    period: TariffPeriod = "month"
    unit_label: str | None = None
    is_visible: bool = True

    @field_validator("name", mode="before")
    @classmethod
    def validate_name(cls, value: Any) -> str | None:
        return normalize_name(value)

    @field_validator("description", mode="before")
    @classmethod
    def validate_description(cls, value: Any) -> str | None:
        return normalize_optional_text(value, DESCRIPTION_MAX_LENGTH, DESCRIPTION_TOO_LONG_MESSAGE)

    @field_validator("amount", mode="after")
    @classmethod
    def validate_amount(cls, value: Decimal | None) -> Decimal | None:
        return check_amount_precision(value)

    @field_validator("currency", mode="before")
    @classmethod
    def validate_currency(cls, value: Any) -> str | None:
        return normalize_currency(value)

    @field_validator("unit_label", mode="before")
    @classmethod
    def validate_unit_label(cls, value: Any) -> str | None:
        return normalize_optional_text(value, UNIT_LABEL_MAX_LENGTH, UNIT_LABEL_TOO_LONG_MESSAGE)


class UpdateTariffRequest(BaseModel):
    """Частичная правка: приходят только те поля, которые нужно изменить."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=NAME_MAX_LENGTH)
    description: str | None = None
    amount: Decimal | None = Field(default=None, ge=0, le=MAX_TARIFF_AMOUNT)
    currency: str | None = None
    period: TariffPeriod | None = None
    unit_label: str | None = None
    is_visible: bool | None = None

    @field_validator("name", mode="before")
    @classmethod
    def validate_name(cls, value: Any) -> str | None:
        return normalize_name(value)

    @field_validator("description", mode="before")
    @classmethod
    def validate_description(cls, value: Any) -> str | None:
        return normalize_optional_text(value, DESCRIPTION_MAX_LENGTH, DESCRIPTION_TOO_LONG_MESSAGE)

    @field_validator("amount", mode="after")
    @classmethod
    def validate_amount(cls, value: Decimal | None) -> Decimal | None:
        return check_amount_precision(value)

    @field_validator("currency", mode="before")
    @classmethod
    def validate_currency(cls, value: Any) -> str | None:
        return normalize_currency(value)

    @field_validator("unit_label", mode="before")
    @classmethod
    def validate_unit_label(cls, value: Any) -> str | None:
        return normalize_optional_text(value, UNIT_LABEL_MAX_LENGTH, UNIT_LABEL_TOO_LONG_MESSAGE)

    @model_validator(mode="after")
    def reject_clearing_required_fields(self) -> "UpdateTariffRequest":
        cleared = [
            field
            for field in NON_NULLABLE_FIELDS
            if field in self.model_fields_set and getattr(self, field) is None
        ]
        if cleared:
            raise ValueError(f"{', '.join(cleared)}: {CLEARING_FORBIDDEN_MESSAGE}")
        return self


class TariffResponse(BaseModel):
    """Тариф для страницы и кабинета.

    `price_label` собирает сервер, `amount` остаётся числом со строковым JSON:
    кабинет показывает то же, что и публичная страница, а формула цены не
    дублируется на клиенте. `editable: false` — роль без права правки: список
    виден, кнопки правки нет.
    """

    id: int
    name: str
    description: str | None
    amount: Decimal
    currency: str
    period: str
    unit_label: str | None
    position: int
    is_visible: bool
    price_label: str
    editable: bool = False


class SetOrganizationTariffRequest(BaseModel):
    """Выбор тарифа организацией: ссылка на строку прайса.

    Отдельная схема, а не `TariffInput`: организация не правит тариф, а только
    ссылается на существующий, поэтому других полей здесь быть не должно и
    `extra="forbid"` их отвергает.
    """

    model_config = ConfigDict(extra="forbid")

    tariff_id: int = Field(ge=1, le=2147483647)


class OrganizationTariffResponse(BaseModel):
    """Тариф организации для кабинета и дашборда.

    `tariff: null` — организация ещё не выбрала тариф, это не ошибка: экран
    показывает состояние «тариф не выбран». `editable` говорит, может ли текущая
    роль сменить тариф: читают его все участники, меняет владелец или админ.
    """

    tariff: TariffResponse | None
    editable: bool = False
