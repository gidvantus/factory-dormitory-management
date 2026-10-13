"""Схемы счёта: запрос на покупку, смена статуса и ответ кабинета.

Сумма едет по JSON строкой (`Numeric` → `"10000.00"`) и остаётся числом со
строковым представлением: копейки не должны теряться на округлении. Рядом едет
готовая подпись `amount_label` — её собирает сервер, а не клиент.

`status_label` тоже серверный: кабинет, письмо и печатная форма показывают один
и тот же текст статуса, а словарь подписей живёт в `app/invoice_status.py`.

Оба тела запроса запрещают лишние поля (`extra="forbid"`): опечатка в имени
поля должна быть ошибкой ввода, а не молча проигнорированным значением.
"""

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict

# Статусы, в которые счёт можно перевести вручную. `new` здесь нет: счёт
# создаётся покупкой, а не сменой статуса.
InvoiceStatus = Literal["new", "paid", "closed", "cancelled"]
UpdatableInvoiceStatus = Literal["paid", "closed", "cancelled"]


class CreateInvoiceRequest(BaseModel):
    """Покупка: какой тариф покупает организация."""

    model_config = ConfigDict(extra="forbid")

    tariff_id: int


class UpdateInvoiceStatusRequest(BaseModel):
    """Смена статуса счёта. `new` недоступен: счёт им не «переоткрывают»."""

    model_config = ConfigDict(extra="forbid")

    status: UpdatableInvoiceStatus


class InvoiceResponse(BaseModel):
    """Счёт для кабинета и раздела «Документы».

    Снимок покупателя и предмета отдаётся как есть: это то, что попало в счёт в
    момент покупки, и оно не меняется вслед за карточкой организации или прайсом.
    `has_act` — признак появившегося акта: по нему экран показывает ссылку.
    `can_manage` — право менять статус: правило ролей (`EDIT_ROLES`) остаётся на
    сервере, а экран не держит его второй версии.
    """

    id: int
    number: str
    status: InvoiceStatus
    status_label: str
    amount: Decimal
    currency: str
    amount_label: str
    tariff_name: str | None
    # Снимок периода: строка из `TARIFF_PERIODS`. Литералом не объявляется —
    # историческая строка переживает правки прайса, и обещать объявленный набор
    # значений у неё нельзя.
    tariff_period: str | None
    buyer_name: str | None
    buyer_inn: str | None
    buyer_kpp: str | None
    buyer_ogrn: str | None
    buyer_address: str | None
    has_act: bool
    can_manage: bool
    paid_at: datetime | None
    created_at: datetime
