"""Счёт за предмет и его печатные документы.

Счёт — это не «намерение купить», а зафиксированная сделка: реквизиты покупателя
и предмет (название и период) копируются в строку счёта в момент покупки. Так
удаление строки прайса или каталога решений либо правка карточки организации
задним числом не меняет уже выставленный счёт: `tariff_id`/`solution_id` при
`ON DELETE SET NULL` обнулятся, а снимок `tariff_name`/`tariff_period`
останется.

**Снимок предмета счёта — тариф или решение.** Вид предмета различает
`item_kind`; строки, заведённые до появления решений, — тарифные (`'tariff'`).
Колонки снимка при этом не разделены по видам намеренно: `tariff_name` хранит
название купленного тарифа **или решения**, `tariff_period` — его период. Так
печатные формы счёта и акта (`app/billing_forms.py`) и ответ счёта остаются
прежними, а переименование колонок в `item_name`/`item_period` — отдельная
задача.

Покупательские поля nullable: пустая заготовка организации — нормальное
состояние (её заполняет поиск по ИНН), а счёт выставляется только у организации
с названием и ИНН — это проверяет ручка покупки, а не схема таблицы.

`invoice_documents` — строки печатных форм счёта. Сам счёт отдаётся файлом без
строки в этой таблице: он есть всегда, а вот акт появляется только при переходе
счёта в статус «оплачен». Уникальность пары `(invoice_id, kind)` не даёт завести
второй акт по одному счёту.

Статусы счёта перечислены здесь только для `CHECK`; правила переходов между ними
живут в `app/invoice_status.py`, а не в модели.
"""

import secrets
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# Статусы счёта. Порядок — как в `CHECK`: список должен быть записан в модели и
# в миграции одинаково.
INVOICE_STATUSES = ("new", "paid", "closed", "cancelled")

# Перечень значений для `CHECK` собирается из константы, как `TARIFF_PERIODS_SQL`.
INVOICE_STATUSES_SQL = ", ".join(f"'{value}'" for value in INVOICE_STATUSES)

# Виды предмета счёта. `tariff` — подписка организации на кабинет, `solution` —
# право на одну функцию магазина улучшений. Поле появилось вместе с решениями,
# поэтому у всех прежних счетов стоит `tariff`: они все тарифные.
INVOICE_ITEM_KINDS = ("tariff", "solution")

INVOICE_ITEM_KINDS_SQL = ", ".join(f"'{value}'" for value in INVOICE_ITEM_KINDS)

TARIFF_ITEM_KIND = "tariff"
SOLUTION_ITEM_KIND = "solution"

# Виды печатных форм, которые хранятся строками. Счёт сюда не входит: он
# собирается из самой строки счёта и существует всегда, а акт — только после
# оплаты.
INVOICE_DOCUMENT_KINDS = ("act",)

INVOICE_DOCUMENT_KINDS_SQL = ", ".join(f"'{value}'" for value in INVOICE_DOCUMENT_KINDS)

# Длина номера счёта с запасом: «СЧ-2026-1» — девять символов, но год и `id`
# растут, а `VARCHAR` дешевле оставить свободным.
NUMBER_MAX_LENGTH = 32

# Приставка временного номера. Номер счёта — `СЧ-<год>-<id>`, а `id` появляется
# только после вставки, поэтому строка сначала сохраняется с временным номером
# и получает окончательный в том же коммите. Уникальность временного номера
# обеспечивает случайный хвост, а не счётчик: два параллельных запроса не должны
# столкнуться на одном значении.
PENDING_NUMBER_PREFIX = "pending-"


def invoice_number(invoice_id: int, year: int) -> str:
    """Номер счёта в формате `СЧ-<год>-<id>`."""
    return f"СЧ-{year}-{invoice_id}"


def pending_invoice_number() -> str:
    """Временный номер для вставки: окончательный вид требует `id` строки."""
    return f"{PENDING_NUMBER_PREFIX}{secrets.token_hex(8)}"


class Invoice(Base):
    """Счёт организации за тариф или за решение магазина улучшений."""

    __tablename__ = "invoices"
    __table_args__ = (
        CheckConstraint(f"status IN ({INVOICE_STATUSES_SQL})", name="ck_invoices_status"),
        CheckConstraint(f"item_kind IN ({INVOICE_ITEM_KINDS_SQL})", name="ck_invoices_item_kind"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Вид предмета счёта. Строка с `item_kind = 'tariff'` заполняет `tariff_id`,
    # строка с `item_kind = 'solution'` — `solution_id`; оба заполненными не
    # бывают, и это правило покупки, а не `CHECK`: исторические строки счёта
    # остаются валидными при любом порядке миграций.
    item_kind: Mapped[str] = mapped_column(String(10), nullable=False, server_default="tariff")
    # Индекса нет: счета ищутся по организации, а не по тарифу.
    tariff_id: Mapped[int | None] = mapped_column(
        ForeignKey("tariffs.id", ondelete="SET NULL"), nullable=True
    )
    # Индекс есть: по решению счёт ищется при проверке живого неоплаченного.
    solution_id: Mapped[int | None] = mapped_column(
        ForeignKey("solutions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    number: Mapped[str] = mapped_column(String(NUMBER_MAX_LENGTH), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="new")
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default="RUB")
    # Снимок покупателя на момент покупки: реквизиты организации могут измениться.
    buyer_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    buyer_inn: Mapped[str | None] = mapped_column(String(12), nullable=True)
    buyer_kpp: Mapped[str | None] = mapped_column(String(9), nullable=True)
    buyer_ogrn: Mapped[str | None] = mapped_column(String(15), nullable=True)
    buyer_address: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Снимок предмета: что именно куплено и на какой период.
    tariff_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    tariff_period: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # Момент оплаты: заполняется переходом в `paid` в `app/invoice_status.py`.
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class InvoiceDocument(Base):
    """Печатная форма, появившаяся у счёта: пока это только акт."""

    __tablename__ = "invoice_documents"
    __table_args__ = (
        UniqueConstraint("invoice_id", "kind", name="uq_invoice_documents_invoice_kind"),
        CheckConstraint(
            f"kind IN ({INVOICE_DOCUMENT_KINDS_SQL})",
            name="ck_invoice_documents_kind",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[int] = mapped_column(
        ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
