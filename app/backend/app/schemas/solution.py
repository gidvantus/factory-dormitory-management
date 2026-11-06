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
    `is_owned = true` — право куплено и действует, пока действует тариф;
    `expires_at` — конец этого тарифа (`null` у бессрочного тарифа), а не срок
    самого права: своего срока у решения больше нет. `false`/`null` —
    права нет: не покупали либо тариф кончился, и тогда право ждёт новой оплаты.
    """

    id: int
    code: str
    name: str
    description: str | None
    amount: Decimal
    currency: str
    # Период в ответе всегда `once`: у решения нет своего срока, цена разовая и
    # действует в рамках оплаченного тарифа организации. Литерал повторяет
    # `CHECK` таблицы, чтобы клиент видел объявленный набор, а не любую строку.
    period: TariffPeriod
    # Готовая цена от сервера: «500 ₽ разово».
    price_label: str
    is_owned: bool
    # Конец действующего тарифа организации, а не срок права.
    expires_at: datetime | None


class SolutionsResponse(BaseModel):
    """Каталог целиком. Обёртка, а не голый список: список решений расширяется
    признаками, и добавление поля не должно ломать клиентов."""

    items: list[SolutionResponse]
