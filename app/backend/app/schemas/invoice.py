"""Схемы счёта: запрос на покупку, смена статуса и ответ кабинета.

Сумма едет по JSON строкой (`Numeric` → `"10000.00"`) и остаётся числом со
строковым представлением: копейки не должны теряться на округлении. Рядом едет
готовая подпись `amount_label` — её собирает сервер, а не клиент.

`status_label` тоже серверный: кабинет, письмо и печатная форма показывают один
и тот же текст статуса, а словарь подписей живёт в `app/invoice_status.py`.

Предмет покупки объявлен двумя взаимоисключающими полями: тариф (`tariff_id`)
или решение магазина улучшений (`solution_id`). Ровно одно из двух — иначе
`422`: запрос «купить сразу и тариф, и решение» не имеет одного предмета счёта,
а запрос без предмета нечего выставлять.

**Тариф требует отметки согласия с офертой.** Поле `offer_accepted` обязательно
для тарифа и равно строго `true`; отсутствие поля и `false` дают `422` с текстом
`OFFER_ACCEPTANCE_REQUIRED_DETAIL`. Значение по умолчанию — `False`, а не
`True`: согласие должно быть явным действием человека, а не тем, что сервер
подставил за него. Для решения магазина улучшений поле необязательно и ни на что
не влияет — решения покупаются без отметки, и поведение магазина эта задача не
меняет.

Оба тела запроса запрещают лишние поля (`extra="forbid"`): опечатка в имени
поля должна быть ошибкой ввода, а не молча проигнорированным значением.
"""

from datetime import datetime
from decimal import Decimal
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, model_validator

from app.offer import OFFER_ACCEPTANCE_REQUIRED_DETAIL

# Статусы, в которые счёт можно перевести вручную. `new` здесь нет: счёт
# создаётся покупкой, а не сменой статуса.
InvoiceStatus = Literal["new", "paid", "closed", "cancelled"]
UpdatableInvoiceStatus = Literal["paid", "closed", "cancelled"]

# Вид предмета счёта — тот же набор, что держит `CHECK` в таблице.
InvoiceItemKind = Literal["tariff", "solution"]

# Текст отказа схемы: он попадает в 422 и объясняет, чего не хватает.
ITEM_REQUIRED_MESSAGE = "Укажите ровно один предмет счёта: tariff_id или solution_id"


class CreateInvoiceRequest(BaseModel):
    """Покупка: какой предмет покупает организация — тариф или решение.

    `offer_accepted` — явная отметка согласия с офертой. По умолчанию `False`:
    сервер не подставляет согласие за человека. Для тарифа обязательна, для
    решения не проверяется.
    """

    model_config = ConfigDict(extra="forbid")

    tariff_id: int | None = None
    solution_id: int | None = None
    offer_accepted: bool = False

    @model_validator(mode="after")
    def _exactly_one_item(self) -> Self:
        """Один предмет на счёт: оба поля или ни одного — ошибка ввода."""
        if (self.tariff_id is None) == (self.solution_id is None):
            raise ValueError(ITEM_REQUIRED_MESSAGE)
        return self

    @model_validator(mode="after")
    def _offer_is_accepted_for_a_tariff(self) -> Self:
        """Тариф без отметки оферты не покупается: `422` с текстом под чекбоксом.

        Проверка идёт после проверки предмета: у запроса без предмета причина
        отказа — отсутствие предмета, а не отсутствие отметки. Решение отметки не
        требует — поле для него необязательно и ни на что не влияет.
        """
        if self.tariff_id is not None and self.offer_accepted is not True:
            raise ValueError(OFFER_ACCEPTANCE_REQUIRED_DETAIL)
        return self


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
    # Вид предмета: тариф или решение магазина улучшений. Снимок предмета лежит
    # в `tariff_name`/`tariff_period` для обоих видов — переименование колонок
    # вынесено в отдельную задачу.
    item_kind: InvoiceItemKind
    amount: Decimal
    currency: str
    amount_label: str
    # Название предмета: тарифа или решения. Колонка называется `tariff_name`
    # исторически — снимок появился вместе со счетами за тариф.
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
