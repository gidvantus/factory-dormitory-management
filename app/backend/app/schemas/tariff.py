"""Схемы чтения тарифов: публичный прайс и тариф организации.

Запросов на создание и правку здесь нет: тариф привязывается при покупке или
администратором платформы, а кабинет и публичная страница тарифы только читают.
Поэтому остались два ответа и словарь периодов.

Сумма едет по JSON строкой (`Numeric` → `"5000.00"`), поэтому тип `Decimal`, а не
`float`: копейки не должны теряться на округлении. `period` в базе —
`VARCHAR(10)` с `CHECK` по тем же трём значениям, что перечисляет `TariffPeriod`,
поэтому ответ типизирован литералом: клиент получает не любую строку, а
объявленный набор.
"""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

# Периоды списания — те же, что разрешает `CHECK` в таблице.
TariffPeriod = Literal["month", "year", "once", "half_year"]


class TariffResponse(BaseModel):
    """Тариф для страницы и кабинета.

    `price_label` собирает сервер, `amount` остаётся числом со строковым JSON:
    кабинет показывает то же, что и публичная страница, а формула цены не
    дублируется на клиенте.
    """

    id: int
    name: str
    description: str | None
    amount: Decimal
    currency: str
    period: TariffPeriod
    unit_label: str | None
    position: int
    is_visible: bool
    price_label: str


class OrganizationTariffResponse(BaseModel):
    """Тариф организации для кабинета и дашборда.

    `tariff: null` — организации тариф ещё не назначен, это не ошибка: экран
    показывает состояние «тариф не назначен». Правки здесь нет, поэтому ответ
    состоит только из данных.
    """

    tariff: TariffResponse | None
