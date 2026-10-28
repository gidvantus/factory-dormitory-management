"""Схемы чтения тарифов: публичный прайс и тариф организации.

Запросов на создание и правку здесь нет: тариф привязывается при покупке или
администратором платформы, а кабинет и публичная страница тарифы только читают.
Поэтому остались два ответа и словарь периодов.

Сумма едет по JSON строкой (`Numeric` → `"5000.00"`), поэтому тип `Decimal`, а не
`float`: копейки не должны теряться на округлении. `period` в базе —
`VARCHAR(10)` с `CHECK` по тем же значениям, что перечисляет `TariffPeriod`,
поэтому ответ типизирован литералом: клиент получает не любую строку, а
объявленный набор.

**Срок тарифа.** Ответ `/current` описывает не одну строку прайса, а подписку
организации: действующий тариф и его конец (`ends_at`), остаток дней
(`days_left`), признак скорого конца (`is_expiring`) и оплаченный вперёд период
(`next`). Дни и признак считает сервер (`app/subscription.py`): клиент не вычитает
дни из `ends_at` и не держит вторую копию правила «за 14 дней предупредить».
"""

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

# Периоды списания — те же, что разрешает `CHECK` в таблице.
TariffPeriod = Literal["month", "quarter", "half_year", "year", "once"]


class TariffResponse(BaseModel):
    """Тариф для страницы и кабинета.

    `price_label` собирает сервер, `amount` остаётся числом со строковым JSON:
    кабинет показывает то же, что и публичная страница, а формула цены не
    дублируется на клиенте.

    `max_members` — предел мест яруса, `null` — без ограничения. `tooltip` —
    подсказка к карточке. `group_code` — код яруса: строки одного яруса с разным
    сроком делят его, и клиент собирает из них переключатель срока.
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
    max_members: int | None
    tooltip: str | None
    group_code: str | None
    price_label: str


class NextTariffResponse(BaseModel):
    """Оплаченный вперёд период: тариф и день, с которого он действует.

    `starts_at` — это `tariff_ends_at` текущего периода: в этот момент текущий
    тариф уже не действует (граница исключающая), поэтому будущий начинается
    ровно им.
    """

    tariff: TariffResponse
    starts_at: datetime


class OrganizationTariffResponse(BaseModel):
    """Подписка организации для кабинета и дашборда.

    `tariff: null` — действующего тарифа нет: либо его ещё не было (работает
    пробный период или кабинет закрыт), либо срок истёк и продления не оплачено.
    Это не ошибка: экран показывает состояние «тариф не назначен» или закрытый
    кабинет.

    `ends_at: null` при непустом `tariff` — бессрочный тариф. `days_left` у него
    `0`: конца, до которого можно считать дни, нет. `is_expiring` — осталось
    `EXPIRING_DAYS` суток или меньше; блок предупреждения показывается только по
    этому признаку.
    """

    tariff: TariffResponse | None
    ends_at: datetime | None
    days_left: int
    is_expiring: bool
    next: NextTariffResponse | None
