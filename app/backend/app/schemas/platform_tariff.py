"""Правка тарифа платформы: тело `PATCH /api/platform/tariffs/{tariff_id}`.

Схема одна, ответа здесь нет намеренно: форма ответа на весь API одна —
`TariffResponse` из `app/schemas/tariff.py`, и её не дублируют.

Тело собрано по правилу платформенного контура: все поля необязательны, а
меняются только те, что пришли (`payload.model_fields_set`). Поэтому `None` в
поле — это не «очистить», а «поле не прислали»: исключение только у
`description` и `max_members`, где `null` — осмысленное значение («уточнения
нет» и «без ограничения»).

**Тексты отказов — часть контракта.** Фронтенд кабинета показывает `detail`
дословно, снимая приставку `Value error, ` (`operator/frontend/src/api/client.ts`),
поэтому валидаторы здесь свои, а не типы-литералы: у `Literal` текст отказа
английский. `period` объявлен строкой и проверяется валидатором именно поэтому.

Цену принимаем строкой (`"4900.00"`), но и число не отвергаем: кабинет шлёт
строку, а другой потребитель платформенного контура может прислать число.
Копейки после проверки приводятся к двум знакам — так же, как их хранит
`NUMERIC(10, 2)` в PostgreSQL, и юнит-прогон на SQLite видит то же самое.
"""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.tariff import MAX_TARIFF_AMOUNT, TARIFF_PERIODS

# Тексты отказов. Их сверяет тестировщик построчно, поэтому они — константы, а
# не строки по месту: так их же импортирует тест.
NAME_REQUIRED_MESSAGE = "Название не может быть пустым"
NAME_TOO_LONG_MESSAGE = "Название длиннее 120 символов"
AMOUNT_NEGATIVE_MESSAGE = "Цена не может быть отрицательной"
AMOUNT_TOO_LARGE_MESSAGE = "Слишком большая цена"
AMOUNT_NOT_NUMBER_MESSAGE = "Цена должна быть числом"
PERIOD_UNKNOWN_MESSAGE = "Неизвестный период оплаты"
MEMBERS_NEGATIVE_MESSAGE = "Количество пользователей не может быть отрицательным"
IS_VISIBLE_INVALID_MESSAGE = "Состояние должно быть true или false"
DESCRIPTION_INVALID_MESSAGE = "Описание должно быть строкой"

# Длина колонки `tariffs.name`: тот же предел, что у `VARCHAR(120)` в таблице.
NAME_MAX_LENGTH = 120

# Копейки: сумма хранится в `NUMERIC(10, 2)`, и ответ не должен показывать
# третьего знака после точки.
AMOUNT_QUANTUM = Decimal("0.01")


def parse_amount(value: Any) -> Decimal:
    """Сумма из строки или числа. Проверки — в том же порядке, что и в контракте.

    `bool` отвергается отдельно: в Python он подкласс `int`, и `true` иначе
    прошёл бы как единица.
    """
    if isinstance(value, bool):
        raise ValueError(AMOUNT_NOT_NUMBER_MESSAGE)
    if isinstance(value, Decimal):
        amount = value
    elif isinstance(value, int):
        amount = Decimal(value)
    elif isinstance(value, float):
        amount = Decimal(str(value))
    elif isinstance(value, str):
        try:
            amount = Decimal(value.strip())
        except InvalidOperation:
            raise ValueError(AMOUNT_NOT_NUMBER_MESSAGE) from None
    else:
        raise ValueError(AMOUNT_NOT_NUMBER_MESSAGE)
    if not amount.is_finite():
        raise ValueError(AMOUNT_NOT_NUMBER_MESSAGE)
    if amount < 0:
        raise ValueError(AMOUNT_NEGATIVE_MESSAGE)
    if amount > MAX_TARIFF_AMOUNT:
        raise ValueError(AMOUNT_TOO_LARGE_MESSAGE)
    return amount.quantize(AMOUNT_QUANTUM, rounding=ROUND_HALF_UP)


class UpdateTariffRequest(BaseModel):
    """Тело правки тарифа: меняются только присланные поля.

    `currency`, `unit_label`, `position`, `group_code` и `tooltip` здесь
    отсутствуют намеренно (постановка #178): кабинет оператора правит название,
    описание, цену, период и количество пользователей. Лишнее поле — `422`, а не
    молчаливое «проигнорировали».
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    amount: Decimal | None = None
    # Строка, а не `Literal`: текст отказа на неизвестный период — русский.
    period: str | None = None
    # `null` — «без ограничения», а не «ноль мест».
    max_members: int | None = None
    is_visible: bool | None = None

    @field_validator("name", mode="before")
    @classmethod
    def validate_name(cls, value: Any) -> str:
        """Название непустое после `strip()` и не длиннее колонки.

        Пробелы по краям отбрасываются: «  Рост  » и «Рост» — одно название, и
        иначе проверка занятости имени различала бы их.
        """
        if not isinstance(value, str):
            # `null` и не-строка — не «очистка», а отказ: название обязательно.
            raise ValueError(NAME_REQUIRED_MESSAGE)
        stripped = value.strip()
        if not stripped:
            raise ValueError(NAME_REQUIRED_MESSAGE)
        if len(stripped) > NAME_MAX_LENGTH:
            raise ValueError(NAME_TOO_LONG_MESSAGE)
        return stripped

    @field_validator("description", mode="before")
    @classmethod
    def validate_description(cls, value: Any) -> str | None:
        """Описание: строка или `null`. Пустая строка — это «описания нет»."""
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError(DESCRIPTION_INVALID_MESSAGE)
        return value.strip() or None

    @field_validator("amount", mode="before")
    @classmethod
    def validate_amount(cls, value: Any) -> Decimal | None:
        """Цена: не отрицательная и не больше потолка `NUMERIC(10, 2)`."""
        if value is None:
            raise ValueError(AMOUNT_NOT_NUMBER_MESSAGE)
        return parse_amount(value)

    @field_validator("period", mode="before")
    @classmethod
    def validate_period(cls, value: Any) -> str:
        """Период — только из объявленного набора; `null` тоже отказ."""
        if not isinstance(value, str) or value not in TARIFF_PERIODS:
            raise ValueError(PERIOD_UNKNOWN_MESSAGE)
        return value

    @field_validator("max_members")
    @classmethod
    def validate_max_members(cls, value: int | None) -> int | None:
        """`null` — без ограничения; отрицательного числа мест не бывает."""
        if value is not None and value < 0:
            raise ValueError(MEMBERS_NEGATIVE_MESSAGE)
        return value

    @field_validator("is_visible")
    @classmethod
    def validate_is_visible(cls, value: bool | None) -> bool:
        """`null` в этом поле не значит «не менять»: поле прислали — ждём `bool`."""
        if value is None:
            raise ValueError(IS_VISIBLE_INVALID_MESSAGE)
        return value
