"""Схемы реквизитов поставщика: ответ и правка (issue #179).

Контракт кабинета оператора. Правил «реестровой проверки» здесь нет: контрольные
суммы ИНН, ОГРН и БИК не считаются — это защита от опечатки по формату, а не
проверка контрагента. Поэтому проверяется только длина и алфавит цифр.

**Пустое значение — это `null`.** Пустая строка после `strip()` и присланный
`null` означают одно и то же — «поле не заполнено», и превращает строку в `null`
именно API, а не экран. Ответ всегда приходит со всеми полями: пустые — `null`,
а не пропущены.

**Тексты отказов — часть контракта.** Их показывает фронтенд дословно (приставку
`Value error, ` снимает его `client.ts`), поэтому тексты записаны здесь
константами и не собираются по шаблону. Текст про ИНН не дублируется: он живёт в
`app/schemas/organization.py` (`INN_FORMAT_MESSAGE`), и вторая его копия
разошлась бы с первой.

**Длины проверяются здесь, а не `Field(max_length=…)`.** Ограничение pydantic
дало бы английский текст вместо русского, а фронтенд показывает `detail[].msg`
как есть — оператор увидел бы «String should have at most 255 characters».
"""

import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from app.schemas.organization import normalize_inn

# Длины колонок `company_details` (`app/models/company_details.py`). Схема и
# таблица обязаны совпадать: иначе валидная строка падала бы на вставке.
NAME_MAX_LENGTH = 255
ADDRESS_MAX_LENGTH = 500
BANK_NAME_MAX_LENGTH = 255
SIGNATORY_MAX_LENGTH = 300
VAT_NOTE_MAX_LENGTH = 200

# Форматы — только длина и цифры. Контрольные суммы не считаются намеренно.
KPP_LENGTH = 9
OGRN_PATTERN = re.compile(r"^\d{13}$|^\d{15}$")
BANK_BIC_PATTERN = re.compile(r"^\d{9}$")
BANK_ACCOUNT_PATTERN = re.compile(r"^\d{20}$")
CORR_ACCOUNT_PATTERN = re.compile(r"^\d{20}$")

KPP_FORMAT_MESSAGE = "КПП должен состоять из 9 символов"
OGRN_FORMAT_MESSAGE = "ОГРН должен состоять из 13 или 15 цифр"
BANK_BIC_FORMAT_MESSAGE = "БИК банка должен состоять из 9 цифр"
BANK_ACCOUNT_FORMAT_MESSAGE = "Расчётный счёт должен состоять из 20 цифр"
CORR_ACCOUNT_FORMAT_MESSAGE = "Корреспондентский счёт должен состоять из 20 цифр"

NAME_TOO_LONG_MESSAGE = "Название длиннее 255 символов"
ADDRESS_TOO_LONG_MESSAGE = "Адрес длиннее 500 символов"
BANK_NAME_TOO_LONG_MESSAGE = "Банк длиннее 255 символов"
SIGNATORY_TOO_LONG_MESSAGE = "Подписант длиннее 300 символов"
VAT_NOTE_TOO_LONG_MESSAGE = "Строка про НДС длиннее 200 символов"

# Не строка и не `null` — это не «опечатка в реквизите», а неверный тип. Тексты
# у каждого поля свои: клиент показывает их дословно.
TEXT_REQUIRED_MESSAGE = "Значение должно быть строкой"


def normalize_text(value: Any) -> str | None:
    """Строка без пробелов по краям; пустая — `None` (очистка поля).

    `null` остаётся `null`: отсутствие значения и пустая строка означают одно и
    то же, а превращает пустую строку в `null` API, а не экран.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(TEXT_REQUIRED_MESSAGE)
    return value.strip() or None


def limited(value: str | None, limit: int, message: str) -> str | None:
    """Потолок длины с русским текстом: проверяется уже обрезанное значение."""
    if value is not None and len(value) > limit:
        raise ValueError(message)
    return value


def patterned(value: Any, pattern: re.Pattern[str], message: str) -> str | None:
    """Пустое — `None`, непустое обязано целиком совпасть с образцом цифр."""
    text = normalize_text(value)
    if text is not None and pattern.match(text) is None:
        raise ValueError(message)
    return text


def normalize_kpp(value: Any) -> str | None:
    """КПП — ровно 9 символов. Пустое значение — очистка поля."""
    text = normalize_text(value)
    if text is not None and len(text) != KPP_LENGTH:
        raise ValueError(KPP_FORMAT_MESSAGE)
    return text


class UpdateCompanyDetailsRequest(BaseModel):
    """Правка реквизитов поставщика: меняются только присланные поля.

    Поля необязательны: `PATCH {"vat_note": ""}` очищает только строку про НДС и
    не трогает банк. `extra="forbid"` — потому что создание и другие действия
    вне задачи: неизвестное поле это ошибка клиента (`422`), а не молчаливый
    пропуск.

    Пустая строка после `strip()` равна `null` и очищает поле — так «стереть
    значение» выглядит одинаково из любого клиента.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    inn: str | None = None
    kpp: str | None = None
    ogrn: str | None = None
    address: str | None = None
    bank_name: str | None = None
    bank_bic: str | None = None
    bank_account: str | None = None
    corr_account: str | None = None
    signatory: str | None = None
    vat_note: str | None = None

    @field_validator("name", mode="before")
    @classmethod
    def validate_name(cls, value: Any) -> str | None:
        return limited(normalize_text(value), NAME_MAX_LENGTH, NAME_TOO_LONG_MESSAGE)

    @field_validator("inn", mode="before")
    @classmethod
    def validate_inn(cls, value: Any) -> str | None:
        # Тот же нормализатор и тот же текст, что у организации: 10 или 12 цифр.
        return normalize_inn(value)

    @field_validator("kpp", mode="before")
    @classmethod
    def validate_kpp(cls, value: Any) -> str | None:
        return normalize_kpp(value)

    @field_validator("ogrn", mode="before")
    @classmethod
    def validate_ogrn(cls, value: Any) -> str | None:
        return patterned(value, OGRN_PATTERN, OGRN_FORMAT_MESSAGE)

    @field_validator("address", mode="before")
    @classmethod
    def validate_address(cls, value: Any) -> str | None:
        return limited(normalize_text(value), ADDRESS_MAX_LENGTH, ADDRESS_TOO_LONG_MESSAGE)

    @field_validator("bank_name", mode="before")
    @classmethod
    def validate_bank_name(cls, value: Any) -> str | None:
        return limited(normalize_text(value), BANK_NAME_MAX_LENGTH, BANK_NAME_TOO_LONG_MESSAGE)

    @field_validator("bank_bic", mode="before")
    @classmethod
    def validate_bank_bic(cls, value: Any) -> str | None:
        return patterned(value, BANK_BIC_PATTERN, BANK_BIC_FORMAT_MESSAGE)

    @field_validator("bank_account", mode="before")
    @classmethod
    def validate_bank_account(cls, value: Any) -> str | None:
        return patterned(value, BANK_ACCOUNT_PATTERN, BANK_ACCOUNT_FORMAT_MESSAGE)

    @field_validator("corr_account", mode="before")
    @classmethod
    def validate_corr_account(cls, value: Any) -> str | None:
        return patterned(value, CORR_ACCOUNT_PATTERN, CORR_ACCOUNT_FORMAT_MESSAGE)

    @field_validator("signatory", mode="before")
    @classmethod
    def validate_signatory(cls, value: Any) -> str | None:
        return limited(normalize_text(value), SIGNATORY_MAX_LENGTH, SIGNATORY_TOO_LONG_MESSAGE)

    @field_validator("vat_note", mode="before")
    @classmethod
    def validate_vat_note(cls, value: Any) -> str | None:
        return limited(normalize_text(value), VAT_NOTE_MAX_LENGTH, VAT_NOTE_TOO_LONG_MESSAGE)


class CompanyDetailsResponse(BaseModel):
    """Реквизиты поставщика в том виде, в каком их печатает форма и читает кабинет.

    Все поля присутствуют всегда: пустое значение — `null`, а не пропущенное
    поле. `id` у единственной строки всегда `1` (`CHECK (id = 1)`), поэтому он
    приходит и тогда, когда строки в базе нет вовсе: это её адрес, а не признак
    существования.

    `updated_at` — `None`, пока строки нет: момента правки у несуществующей
    строки не бывает, а подставлять «сейчас» значило бы соврать.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str | None
    inn: str | None
    kpp: str | None
    ogrn: str | None
    address: str | None
    bank_name: str | None
    bank_bic: str | None
    bank_account: str | None
    corr_account: str | None
    signatory: str | None
    vat_note: str | None
    updated_at: datetime | None
