"""Тариф публичного прайса.

Прайс живёт в базе, а не в коде: публичная страница `/pricing` читает его
анонимной ручкой, а состав прайса задаётся данными. Кабинет тарифы не правит —
редактор прайса из кабинета и API снят (issue #34), поэтому строки прайса
заводит миграция, а привязка тарифа к организации появляется при покупке или
администратором платформы.

`description` и `unit_label` — необязательные уточнения: описание карточки и
«за что» именно эти деньги («за одно место»). Оба nullable, потому что пустое
уточнение — нормальное состояние, а не незаполненная форма.

`position` задаёт порядок вывода (меньше — выше), `is_visible` — публикацию:
скрытый тариф остаётся в кабинете, но на `/pricing` не попадает ни при каких
параметрах запроса.
"""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Integer,
    Numeric,
    String,
    Text,
    func,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# Периоды списания. Порядок — как в `CHECK`: список должен быть записан в модели
# и в миграции одинаково. Полугодовой период (`half_year`) — не «шесть месяцев»
# словами, а самостоятельный период оплаты: прайс продаёт подписку на полгода
# сразу, и цена за неё не равна шести месячным платежам.
TARIFF_PERIODS = ("month", "year", "once", "half_year")

# Перечень значений для `CHECK` собирается из константы.
TARIFF_PERIODS_SQL = ", ".join(f"'{period}'" for period in TARIFF_PERIODS)

# Потолок суммы: столько влезает в `NUMERIC(10, 2)`.
MAX_TARIFF_AMOUNT = Decimal("99999999.99")


class Tariff(Base):
    """Строка прайса. Название уникально: два тарифа с одним именем неразличимы."""

    __tablename__ = "tariffs"
    __table_args__ = (
        CheckConstraint("amount >= 0", name="ck_tariffs_amount_non_negative"),
        CheckConstraint(f"period IN ({TARIFF_PERIODS_SQL})", name="ck_tariffs_period"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default="RUB")
    period: Mapped[str] = mapped_column(String(10), nullable=False, server_default="month")
    # Что именно стоит этих денег: «за одно место», «за общежитие».
    unit_label: Mapped[str | None] = mapped_column(String(40), nullable=True)
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
