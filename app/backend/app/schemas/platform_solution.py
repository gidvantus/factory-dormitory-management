"""Правка каталога решений платформы: ответ и тело `PATCH /api/platform/solutions/{id}`.

Админский контур магазина улучшений (#188). Публичная витрина (`GET /api/solutions`,
`app/schemas/solution.py`) отвечает карточкой с признаком права организации, а
кабинет оператора видит строку каталога целиком: `code` (гейт функции) и
служебные признаки `position`, `is_visible`, даты создания и правки.

**Форма ответа.** `amount` едет строкой (`Numeric` → `"500.00"`), а
`price_label` собирает сервер через `app.pricing.format_price`: второй формулы
цены нет ни на сервере, ни на клиенте.

**Поля правки.** Меняются только присланные поля (`payload.model_fields_set`),
поэтому `PATCH` одного описания не обнуляет цену. `code` в теле отсутствует
намеренно: это гейт функции (`app.solutions.has_solution`, `TELEGRAM_NOTIFICATIONS`,
`JOURNAL`, `EXTRA_MEMBER_CODE` во фронтенде) и `UNIQUE` в таблице. Присланный
`code` отсекает `extra="forbid"` — `422` со стандартным текстом pydantic, как у
лишнего поля тарифа; своего русского текста у него нет намеренно.

**Тексты отказов — часть контракта.** Фронтенд кабинета показывает `detail`
дословно, снимая приставку `Value error, ` (`operator/frontend/src/api/client.ts`),
поэтому валидаторы здесь свои, а не типы-литералы: у `Literal` текст отказа
английский. `period` объявлен строкой и проверяется валидатором именно поэтому.
Цена проверяется общим `parse_amount` из `app/schemas/platform_tariff.py`:
отрицательная цена, нечисло и потолок `NUMERIC(10, 2)` описаны там одним
экземпляром правила.
"""

from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from app.models.solution import MAX_SOLUTION_AMOUNT
from app.models.tariff import TARIFF_PERIODS
from app.schemas.platform_tariff import (
    AMOUNT_NOT_NUMBER_MESSAGE,
    AMOUNT_TOO_LARGE_MESSAGE,
    DESCRIPTION_INVALID_MESSAGE,
    IS_VISIBLE_INVALID_MESSAGE,
    NAME_REQUIRED_MESSAGE,
    NAME_TOO_LONG_MESSAGE,
    PERIOD_UNKNOWN_MESSAGE,
    parse_amount,
)

# Длина колонки `solutions.name`: тот же предел, что у `VARCHAR(120)` в таблице.
NAME_MAX_LENGTH = 120

# Верхняя граница `position`. Колонка объявлена `INTEGER`, то есть 32 бита со
# знаком: большее число не даёт `IntegrityError`, а падает ошибкой типа данных
# (`DataError` в PostgreSQL), и клиент получил бы `500` вместо `422`.
MAX_POSITION = 2_147_483_647

# Тексты отказов этого модуля. Их сверяет тестировщик построчно, поэтому они —
# константы, а не строки по месту: так их же импортирует тест.
CURRENCY_INVALID_MESSAGE = "Валюта должна состоять из 3 заглавных латинских букв"
POSITION_NOT_INTEGER_MESSAGE = "Порядок должен быть целым числом"
POSITION_NEGATIVE_MESSAGE = "Порядок не может быть отрицательным"
POSITION_TOO_LARGE_MESSAGE = "Слишком большой порядок"

# Валюту печатает `format_price` как есть для незнакомых кодов («KZT 5 000»),
# поэтому набор ограничен тремя заглавными латинскими буквами: иначе оператор
# вписал бы в цену произвольный текст.
CURRENCY_LENGTH = 3


def is_currency_code(value: str) -> bool:
    """Три заглавные латинские буквы — формат колонки `solutions.currency`."""
    if len(value) != CURRENCY_LENGTH:
        return False
    return all("A" <= letter <= "Z" for letter in value)


class SolutionAdminResponse(BaseModel):
    """Строка каталога решений в кабинете оператора.

    Поля — ровно то, что есть у строки `solutions` в базе, плюс готовая подпись
    цены. `is_visible = false` — «не в каталоге»: строка остаётся в реестре и в
    магазине клиента не показывается.
    """

    id: int
    # Машинное имя решения: гейт платной функции и `UNIQUE`. Только показ.
    code: str
    name: str
    description: str | None
    # Сумма строкой: `Numeric` → `"500.00"`.
    amount: Decimal
    currency: str
    period: str
    # Порядок витрины: меньше — выше. Ничья решается `id`.
    position: int
    is_visible: bool
    # Готовая цена от сервера: «500 ₽ в месяц».
    price_label: str
    created_at: datetime
    updated_at: datetime


class UpdateSolutionRequest(BaseModel):
    """Тело правки строки каталога: меняются только присланные поля.

    Здесь ровно поля формы кабинета: название, описание, цена, валюта, период,
    порядок и состояние. Лишнее поле — `422`, а не молчаливое «проигнорировали».
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    amount: Decimal | None = None
    currency: str | None = None
    # Строка, а не `Literal`: текст отказа на неизвестный период — русский.
    period: str | None = None
    position: int | None = None
    is_visible: bool | None = None

    @field_validator("name", mode="before")
    @classmethod
    def validate_name(cls, value: Any) -> str:
        """Название непустое после `strip()` и не длиннее колонки.

        Пробелы по краям отбрасываются: «  Журнал  » и «Журнал» — одно название,
        и иначе проверка занятости имени различала бы их.
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
    def validate_amount(cls, value: Any) -> Decimal:
        """Цена: число или строка, не отрицательная и не больше потолка колонки.

        Потолок `MAX_SOLUTION_AMOUNT` совпадает с потолком тарифа, поэтому
        проверку делает общий `parse_amount`, а тест держит равенство чисел:
        разойтись молча они не могут.
        """
        if value is None:
            raise ValueError(AMOUNT_NOT_NUMBER_MESSAGE)
        amount = parse_amount(value)
        # Потолок колонки `solutions.amount` — `MAX_SOLUTION_AMOUNT`. Сегодня он
        # совпадает с тарифным, поэтому отсекает `parse_amount`; эта проверка
        # остаётся на случай, если числа разойдутся, и тест держит их равенство.
        if amount > MAX_SOLUTION_AMOUNT:
            raise ValueError(AMOUNT_TOO_LARGE_MESSAGE)
        return amount

    @field_validator("currency", mode="before")
    @classmethod
    def validate_currency(cls, value: Any) -> str:
        """Валюта — три заглавные латинские буквы; `null` и мусор — отказ."""
        if not isinstance(value, str) or not is_currency_code(value):
            raise ValueError(CURRENCY_INVALID_MESSAGE)
        return value

    @field_validator("period", mode="before")
    @classmethod
    def validate_period(cls, value: Any) -> str:
        """Период — только из объявленного набора; `null` тоже отказ."""
        if not isinstance(value, str) or value not in TARIFF_PERIODS:
            raise ValueError(PERIOD_UNKNOWN_MESSAGE)
        return value

    @field_validator("position", mode="before")
    @classmethod
    def validate_position(cls, value: Any) -> int:
        """Порядок витрины: целое от нуля до потолка колонки.

        `bool` отвергается отдельно: в Python он подкласс `int`, и `true` иначе
        прошёл бы как единица. Строка тоже отказ: телу контракта обещано число,
        а `"3"` в базе превратился бы в порядок, которого клиент не присылал.
        """
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(POSITION_NOT_INTEGER_MESSAGE)
        if value < 0:
            raise ValueError(POSITION_NEGATIVE_MESSAGE)
        if value > MAX_POSITION:
            raise ValueError(POSITION_TOO_LARGE_MESSAGE)
        return value

    @field_validator("is_visible", mode="before")
    @classmethod
    def validate_is_visible(cls, value: Any) -> bool:
        """`null` в этом поле не значит «не менять»: поле прислали — ждём `bool`.

        `1` и `"true"` тоже отказ: контракт обещает `true`/`false`, а `pydantic`
        иначе привёл бы к `bool` и единицу, и строку, и текст отказа остался бы
        недостижимым.
        """
        if not isinstance(value, bool):
            raise ValueError(IS_VISIBLE_INVALID_MESSAGE)
        return value
