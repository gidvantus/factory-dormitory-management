"""Схемы счёта: запрос на покупку, смена статуса и ответ кабинета.

Сумма едет по JSON строкой (`Numeric` → `"10000.00"`) и остаётся числом со
строковым представлением: копейки не должны теряться на округлении. Рядом едет
готовая подпись `amount_label` — её собирает сервер, а не клиент.

`status_label` тоже серверный: кабинет, письмо и печатная форма показывают один
и тот же текст статуса, а словарь подписей живёт в `app/invoice_status.py`.

Предмет покупки объявлен тремя полями: тариф (`tariff_id`), решение магазина
улучшений (`solution_id`) и докупленные места сверх тарифа (`seats` — сколько
мест). Решение покупается только отдельным счётом: `solution_id` вместе с
`tariff_id` или `seats` — `422`, потому что у решения своё право и свой срок.
Тариф и места, наоборот, сочетаются: `{ "tariff_id": N, "seats": K }` — одна
сделка и один счёт с двумя позициями. Запрос без предмета даёт `422`. `seats` —
целое от 1 до `MAX_SEATS_PER_PURCHASE`: потолок один и тот же у схемы и у
магазина.

**Тариф требует отметки согласия с офертой.** Поле `offer_accepted` обязательно
для тарифа и равно строго `true`; отсутствие поля и `false` дают `422` с текстом
`OFFER_ACCEPTANCE_REQUIRED_DETAIL`. Значение по умолчанию — `False`, а не
`True`: согласие должно быть явным действием человека, а не тем, что сервер
подставил за него. Для решения магазина улучшений и для мест поле необязательно и
ни на что не влияет — решения и места покупаются без отметки.

Оба тела запроса запрещают лишние поля (`extra="forbid"`): опечатка в имени
поля должна быть ошибкой ввода, а не молча проигнорированным значением.
"""

from datetime import datetime
from decimal import Decimal
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.offer import OFFER_ACCEPTANCE_REQUIRED_DETAIL
from app.seats import MAX_SEATS_PER_PURCHASE

# Статусы, в которые счёт можно перевести вручную. `new` здесь нет: счёт
# создаётся покупкой, а не сменой статуса.
InvoiceStatus = Literal["new", "paid", "closed", "cancelled"]
UpdatableInvoiceStatus = Literal["paid", "closed", "cancelled"]

# Вид предмета счёта — тот же набор, что держит `CHECK` в таблице.
InvoiceItemKind = Literal["tariff", "solution", "seats"]

# Тексты отказа схемы: они попадают в 422 и объясняют, чего не хватает.
ITEM_REQUIRED_MESSAGE = "Укажите предмет счёта: tariff_id, solution_id или seats"
SOLUTION_ALONE_MESSAGE = (
    "Решение покупается отдельным счётом: solution_id несовместим с tariff_id и seats"
)


class CreateInvoiceRequest(BaseModel):
    """Покупка: что организация покупает — тариф, решение или места.

    **Тариф и места покупаются вместе.** `tariff_id` вместе с `seats` — это
    одна сделка и один счёт с двумя позициями, поэтому «ровно одно поле» из #168
    заменено составом: решение (`solution_id`) несовместимо с остальными полями,
    а `tariff_id` и `seats` сочетаются. `seats` без `tariff_id` — докупка к
    живому тарифу, ровно как в #168.

    `offer_accepted` — явная отметка согласия с офертой. По умолчанию `False`:
    сервер не подставляет согласие за человека. Для тарифа (в том числе в
    покупке «тариф + места») обязательна, для решения и одних мест не
    проверяется.
    """

    model_config = ConfigDict(extra="forbid")

    tariff_id: int | None = None
    solution_id: int | None = None
    # Сколько мест докупить. Сумму считает сервер по цене строки каталога и
    # ступенчатой скидке, а не клиент: в теле едет количество, а не деньги.
    seats: int | None = Field(default=None, gt=0, le=MAX_SEATS_PER_PURCHASE)
    offer_accepted: bool = False

    @model_validator(mode="after")
    def _item_is_chosen(self) -> Self:
        """Предмет выбран, а решение не смешано с другими предметами.

        Два отказа разными текстами: «ничего не выбрано» и «решение вместе с
        тарифом или местами» — разные ошибки формы, и клиент показывает текст
        сервера как есть.
        """
        if self.solution_id is not None:
            if self.tariff_id is not None or self.seats is not None:
                raise ValueError(SOLUTION_ALONE_MESSAGE)
            return self
        if self.tariff_id is None and self.seats is None:
            raise ValueError(ITEM_REQUIRED_MESSAGE)
        return self

    @model_validator(mode="after")
    def _offer_is_accepted_for_a_tariff(self) -> Self:
        """Тариф без отметки оферты не покупается: `422` с текстом под чекбоксом.

        Проверка идёт после проверки предмета: у запроса без предмета причина
        отказа — отсутствие предмета, а не отсутствие отметки. Решение и одни
        места отметки не требуют — поле для них необязательно и ни на что не
        влияет.
        """
        if self.tariff_id is not None and self.offer_accepted is not True:
            raise ValueError(OFFER_ACCEPTANCE_REQUIRED_DETAIL)
        return self


class UpdateInvoiceStatusRequest(BaseModel):
    """Смена статуса счёта. `new` недоступен: счёт им не «переоткрывают»."""

    model_config = ConfigDict(extra="forbid")

    status: UpdatableInvoiceStatus


class InvoiceItemResponse(BaseModel):
    """Позиция счёта: что куплено, сколько и за какую сумму.

    У покупки «тариф + места» позиций две, и сумма счёта — их сумма. `amount`
    позиции — готовое число со своей подписью в печатной форме: клиент не
    пересчитывает ни скидку, ни итог.

    `quantity` заполнено только у позиции мест; у тарифа и решения оно `null` —
    количество там неприменимо, а не «одно». `unit_amount` у мест — цена одного
    места со скидкой ступени, поэтому `unit_amount × quantity = amount` сходится
    до копейки.
    """

    kind: InvoiceItemKind
    name: str | None
    period: str | None
    quantity: int | None
    unit_amount: Decimal | None
    amount: Decimal


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
    # Вид предмета первой позиции: тариф, решение магазина улучшений или
    # докупленные места. У счёта за «тариф + места» это `tariff` — тариф идёт
    # первой позицией, а места второй, и полный состав лежит в `items`.
    item_kind: InvoiceItemKind
    # Сколько мест докуплено. `null` у тарифа, решения и у счёта за «тариф +
    # места»: здесь количество относится к счёту, выставленному только за места,
    # а состав покупки отдаёт `items`.
    quantity: int | None
    amount: Decimal
    currency: str
    amount_label: str
    # Название предмета первой позиции: тарифа или решения. Колонка называется
    # `tariff_name` исторически — снимок появился вместе со счетами за тариф.
    tariff_name: str | None
    # Снимок периода первой позиции: строка из `TARIFF_PERIODS`. Литералом не
    # объявляется — историческая строка переживает правки прайса, и обещать
    # объявленный набор значений у неё нельзя.
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
    # Состав счёта: одна позиция у счёта за один предмет и две у счёта за
    # «тариф + места». Сумма позиций равна `amount`. Исторический счёт, до
    # которого бэкфилл не дошёл, отдаётся одной позицией из своего снимка —
    # список никогда не пуст.
    items: list[InvoiceItemResponse]
