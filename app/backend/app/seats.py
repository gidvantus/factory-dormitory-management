"""Докупка мест сверх мест тарифа: предмета счёта и счётчика организации.

Предел приглашений считается как `tariffs.max_members` действующего тарифа плюс
`organizations.extra_seats` (`app/subscription.py`). Здесь живёт вторая половина
этого правила — то, из чего берётся счётчик, и то, чем он растёт:

* строка каталога магазина улучшений, по которой продаются места
  (`catalog_row`), — обычная строка `solutions` с кодом `extra_member`, поэтому
  карточка в магазине, название и цена едут из того же каталога, что у решений;
* `add_seats` — единственное место, где счётчик меняется. Вызывает его оплата
  счёта (`app/invoice_status.py`), и только она: покупка и выставление счёта
  мест не добавляют, счётчик растёт оплатой.

Модуль без HTTP, как `app/solutions.py`: тексты отказов здесь, потому что они
часть контракта с клиентом — кабинет передаёт их дословно и не переписывает, — а
проверки покупки стоят в ручке (`app/api/billing.py`).

Место живёт вместе с подпиской: отдельного срока у него нет, при продлении
тарифа он остаётся, к ярусу не привязан. Поэтому ни периода, ни даты у счётчика
нет, и продлить или вернуть место нечем.
"""

from decimal import ROUND_HALF_UP, Decimal
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.organization import Organization
from app.models.solution import Solution

# Код строки каталога «Дополнительные сотрудники». Он же стоит в seed-строке
# каталога (`0064_extra_seats`), и по нему карточка магазина узнаёт, что
# показывает места, а не решение.
EXTRA_MEMBER_CODE = "extra_member"

# Сколько мест можно докупить одним счётом. Ограничение схемы и оно же — потолок
# цикла: больше ста мест за раз не продаётся, и «N = 10 000» не проходит 422.
MAX_SEATS_PER_PURCHASE = 100

# Шаг скидки: каждый полный десяток докупленных мест снимает с цены места 10 %.
DISCOUNT_STEP_PERCENT = 10

# Потолок скидки: с пятидесяти мест она упирается в 50 % и дальше не растёт.
MAX_DISCOUNT_PERCENT = 50

# Десяток мест — граница ступени. Ступень начинается с полного десятка, поэтому
# девять мест стоят полную цену, десять — уже со скидкой 10 %.
SEATS_IN_STEP = 10


class SeatBand(NamedTuple):
    """Ступень скидки за места: границы по количеству и процент скидки.

    `end = None` — последняя ступень, открытая вверх: в ответе ручки её `to`
    равен `MAX_SEATS_PER_PURCHASE`, а не бесконечности, потому что больше за раз
    не продаётся.
    """

    start: int
    end: int | None
    discount_percent: int


# Ступени цены мест. Скидка действует на **весь набор** мест, а не только на
# места сверх десятка: десять мест стоят 90 % цены каждое, и это же правило
# записано словами в постановке (#177).
SEAT_BANDS: tuple[SeatBand, ...] = (
    SeatBand(start=1, end=9, discount_percent=0),
    SeatBand(start=10, end=19, discount_percent=10),
    SeatBand(start=20, end=29, discount_percent=20),
    SeatBand(start=30, end=39, discount_percent=30),
    SeatBand(start=40, end=49, discount_percent=40),
    SeatBand(start=50, end=None, discount_percent=50),
)


def discount_percent(quantity: int) -> int:
    """Скидка на весь набор мест: 10 % за каждый полный десяток, не больше 50 %.

    Количество вне продажи (`0` и меньше) скидки не даёт: это не «отрицательный
    десяток», а отсутствие покупки, и считать по нему нечего.
    """
    if quantity <= 0:
        return 0
    return min(MAX_DISCOUNT_PERCENT, DISCOUNT_STEP_PERCENT * (quantity // SEATS_IN_STEP))


def _kopecks(amount: Decimal) -> Decimal:
    """Округление денег до копеек: половина вверх, как в остальном прайсе."""
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def unit_amount(base: Decimal, quantity: int) -> Decimal:
    """Цена одного места со скидкой ступени, округлённая до копеек.

    Округляется именно цена места, а не произведение: сумма считается как
    `unit_amount × quantity`, поэтому в счёте `1 350,00 ₽ × 10` сходится с
    итогом до копейки, а не «почти».
    """
    discount = Decimal(discount_percent(quantity))
    return _kopecks(base * (Decimal(100) - discount) / Decimal(100))


def seats_total(base: Decimal, quantity: int) -> Decimal:
    """Сумма за набор мест: цена места со скидкой, умноженная на количество."""
    return _kopecks(unit_amount(base, quantity) * quantity)


# Тексты отказов покупки. Они — часть контракта с клиентом: кабинет показывает
# их дословно, поэтому живут рядом с предметом, а не в ручке.
SEATS_REQUIRE_TARIFF_DETAIL = "Докупить места можно после оплаты тарифа"
SEATS_UNLIMITED_TARIFF_DETAIL = "Тариф без ограничения по сотрудникам: докупать места не нужно"
SEATS_NOT_FOR_SALE_DETAIL = "Дополнительные сотрудники не продаются"


def catalog_row(db: Session) -> Solution | None:
    """Видимая строка каталога, по которой продаются места. `None` — не продаются.

    Скрытая строка (`is_visible = false`) не продаётся: у решений скрытую строку
    можно купить по `id`, а здесь предмет выбирается не `id`, а кодом, поэтому
    видимость — единственный признак «в продаже». Строку могли не завести вовсе
    (не применённая ревизия `0064_extra_seats`) — это то же состояние.

    Обратное правило живёт в ручке покупки (`app/api/billing.py`): эту же строку
    нельзя купить полем `solution_id` — иначе оплата завела бы право на
    `extra_member`, которого никто не читает, а счётчик мест не вырос бы.
    """
    return db.scalar(
        select(Solution).where(
            Solution.code == EXTRA_MEMBER_CODE,
            Solution.is_visible.is_(True),
        )
    )


def add_seats(organization: Organization, quantity: int) -> None:
    """Прибавить докупленные места организации. Коммитит вызывающий.

    Коммитит вызывающий (`app/invoice_status.py::change_status`): оплата счёта —
    одна транзакция вместе с датой оплаты и актом, и частично применённой она
    быть не должна. Строка организации к этому моменту уже заблокирована тем же
    приёмом (`_lock_organization`), поэтому две одновременные оплаты не разойдутся.

    Отрицательное количество код не пишет: его не пропускает ни схема запроса, ни
    `CHECK` на количестве счёта, откуда число берётся.
    """
    organization.extra_seats = organization.extra_seats + quantity
