"""Каталог решений магазина улучшений и права организаций на них.

Решение — это отдельный продаваемый предмет, а не тариф с признаком вида.
Тариф держит кабинет живым целиком (`organizations.tariff_id`), а решение даёт
право на одну функцию: без действующего права пункта меню и страницы настроек
нет, и сама функция не работает. Смешивать их в одной таблице нельзя — иначе
оплата решения открывала бы кабинет, а правка прайса меняла бы доступ.

`expires_at` — конец периода права, посчитанный в момент оплаты из `period`
строки каталога. `NULL` означает бессрочное право (`period = 'once'`), а не
«период ещё не начался»: право появляется только оплатой счёта, и у только что
выданного права срок уже есть.

Строка права одна на пару «организация — решение»: `UNIQUE (organization_id,
solution_id)` вместе с блокировкой организации в `app/invoice_status.py` не
даёт двум одновременным оплатам завести два права. Продление правит эту же
строку, а `invoice_id` хранит ссылку на счёт последней оплаты.

`solution_id` в счёте — `SET NULL`: удаление строки каталога уже выставленный
счёт не ломает, потому что название и период остались в его снимке.
"""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.tariff import TARIFF_PERIODS, TARIFF_PERIODS_SQL

# Периоды решения — тот же набор, что у тарифов, и та же константа-источник:
# отдельного списка здесь нет намеренно. Пара «модель — миграция» должна
# объявлять набор одинаково, поэтому `CHECK` собирается из `TARIFF_PERIODS`.
SOLUTION_PERIODS = TARIFF_PERIODS
SOLUTION_PERIODS_SQL = TARIFF_PERIODS_SQL

# Потолок суммы: столько влезает в `NUMERIC(10, 2)`.
MAX_SOLUTION_AMOUNT = Decimal("99999999.99")


class Solution(Base):
    """Строка каталога магазина улучшений.

    `code` — машинное имя решения: по нему код спрашивает право (`has_solution`),
    и оно не меняется при переименовании карточки. `name` и `code` уникальны:
    две строки с одним именем или кодом неразличимы для покупателя и для кода.
    """

    __tablename__ = "solutions"
    __table_args__ = (
        CheckConstraint("amount >= 0", name="ck_solutions_amount_non_negative"),
        CheckConstraint(f"period IN ({SOLUTION_PERIODS_SQL})", name="ck_solutions_period"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default="RUB")
    period: Mapped[str] = mapped_column(String(10), nullable=False, server_default="month")
    # Порядок вывода в магазине: меньше — выше.
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    is_visible: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class OrganizationSolution(Base):
    """Право организации на решение: одна строка на пару «организация — решение».

    Право принадлежит организации, а не пользователю: купил владелец — пользуются
    все, у кого есть доступ к кабинету. `granted_at` фиксирует первую выдачу (в
    том числе при продлении задним числом), `expires_at` — конец текущего
    периода, `invoice_id` — счёт последней оплаты.
    """

    __tablename__ = "organization_solutions"
    __table_args__ = (
        UniqueConstraint(
            "organization_id",
            "solution_id",
            name="uq_organization_solutions_organization_solution",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    solution_id: Mapped[int] = mapped_column(
        ForeignKey("solutions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # `NULL` — бессрочное право (`period = 'once'`).
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    invoice_id: Mapped[int | None] = mapped_column(
        ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True
    )
