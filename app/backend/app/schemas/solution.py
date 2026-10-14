"""Схемы магазина улучшений: каталог решений и признак владения.

Запросов на покупку и правку здесь нет: решение покупается обычным счётом
(`POST /api/billing/invoices` с `solution_id`), а каталог кабинет только читает.
Строка каталога — данные, поэтому её заводит миграция, а не API.

Сумма едет по JSON строкой (`Numeric` → `"500.00"`), как у тарифов, а готовая
подпись `price_label` собирается сервером через `app/pricing.format_price`:
фронт цену не считает и не форматирует.
"""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel

from app.schemas.tariff import TariffPeriod


class SolutionResponse(BaseModel):
    """Решение в магазине: карточка, цена и состояние права у организации.

    `is_owned` и `expires_at` описывают право **организации** пользователя:
    `expires_at: null` при `is_owned = true` — бессрочное право (`once`), а при
    `is_owned = false` — права нет вовсе.
    """

    id: int
    code: str
    name: str
    description: str | None
    amount: Decimal
    currency: str
    # Период из того же набора, что у тарифов: литерал повторяет `CHECK` таблицы.
    period: TariffPeriod
    # Готовая цена от сервера: «500 ₽ в месяц».
    price_label: str
    is_owned: bool
    expires_at: datetime | None


class SolutionsResponse(BaseModel):
    """Каталог целиком. Обёртка, а не голый список: список решений расширяется
    признаками, и добавление поля не должно ломать клиентов."""

    items: list[SolutionResponse]
