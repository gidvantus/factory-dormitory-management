"""Позиции счёта `invoice_items` и бэкфилл исторических счетов (issue #177).

Счёт был однопредметным: один `item_kind`, один снимок `tariff_name`/
`tariff_period` и одна сумма. Покупка «тариф + места» — это одна сделка и один
документ с двумя позициями, и однопредметная строка её не выражает.

**Что заводится.** Таблица `invoice_items`: счёт, порядок строки, вид предмета
(`tariff`, `solution`, `seats`), снимок названия и периода, количество (только у
мест), цена единицы и сумма позиции, ссылки на строки прайса и каталога. Пара
`(invoice_id, position)` уникальна, `CHECK` держит набор видов и положительное
количество, `ON DELETE CASCADE` по счёту — позиции не переживают свой документ.

**`invoices.amount` остаётся канонической суммой** и равен сумме позиций. Это
правило соблюдает ручка покупки, а расхождение ловит тест, а не проверка в
рантайме: чтение счёта не должно падать из-за исторической строки.

**Бэкфилл.** У каждого существующего счёта появляется ровно одна позиция из его
же снимка: `kind = item_kind`, `name = tariff_name`, `period = tariff_period`,
`quantity = quantity`, `amount = amount`, `position = 1`. Цена единицы
восстанавливается как `amount / quantity` у счёта за места (там сумма — цена
места × количество) и как сама сумма у тарифа и решения (количество у них
неприменимо). Вставка защищена `NOT EXISTS` по счёту: повторный прогон шага
после обрыва не задвоит позиции.

**Откат снимает таблицу целиком.** Разбивка при этом теряется, а снимок в строке
счёта остаётся: читатели без позиций отдают одну позицию из `item_kind`,
`tariff_name` и `quantity` (`app/models/invoice.py::subject_items`). Поэтому
откат безопасен для чтения и не безопасен для разбивки — на стенде он
применяется только по решению человека (`docs/ci.md`).

Все SQL — константами модуля: их разбирает `tests/test_invoice_items_migration.py`.
Идентификатор ревизии короче 32 символов (`varchar(32)` у `version_num`).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0066_invoice_items"
down_revision: str | None = "0065_license_prices"

branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE_NAME = "invoice_items"
INDEX_NAME = "ix_invoice_items_invoice_id"
UNIQUE_NAME = "uq_invoice_items_invoice_position"
KIND_CHECK = "ck_invoice_items_kind"
QUANTITY_CHECK = "ck_invoice_items_quantity_positive"

# Набор видов предмета позиции. Тот же, что объявляет модель
# (`INVOICE_ITEM_KINDS`): список записан здесь словами, потому что ревизия
# обязана читаться и исполняться без импорта приложения.
ITEM_KINDS_SQL = "'tariff', 'solution', 'seats'"

# Условие `CHECK` на количество: `NULL` — «не про количество» (тариф, решение),
# у мест — всегда положительное.
QUANTITY_CHECK_SQL = "quantity IS NULL OR quantity > 0"

# Бэкфилл: одна позиция на каждый исторический счёт. `ROUND(..., 2)` — чтобы
# SQLite и PostgreSQL дали одинаковую цену единицы у счёта за места.
BACKFILL_SQL = sa.text(
    """
    INSERT INTO invoice_items (invoice_id, position, kind, name, period,
                               quantity, unit_amount, amount, tariff_id, solution_id)
    SELECT invoices.id,
           1,
           invoices.item_kind,
           invoices.tariff_name,
           invoices.tariff_period,
           invoices.quantity,
           CASE
               WHEN invoices.item_kind = 'seats'
                    AND invoices.quantity IS NOT NULL
                    AND invoices.quantity > 0
               THEN ROUND(invoices.amount / invoices.quantity, 2)
               ELSE invoices.amount
           END,
           invoices.amount,
           invoices.tariff_id,
           invoices.solution_id
    FROM invoices
    WHERE NOT EXISTS (
        SELECT 1 FROM invoice_items WHERE invoice_items.invoice_id = invoices.id
    )
    """
)


def upgrade() -> None:
    op.create_table(
        TABLE_NAME,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "invoice_id",
            sa.Integer(),
            sa.ForeignKey("invoices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("name", sa.String(120), nullable=True),
        sa.Column("period", sa.String(10), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=True),
        sa.Column("unit_amount", sa.Numeric(10, 2), nullable=True),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column(
            "tariff_id",
            sa.Integer(),
            sa.ForeignKey("tariffs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "solution_id",
            sa.Integer(),
            sa.ForeignKey("solutions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.UniqueConstraint("invoice_id", "position", name=UNIQUE_NAME),
        sa.CheckConstraint(f"kind IN ({ITEM_KINDS_SQL})", name=KIND_CHECK),
        sa.CheckConstraint(QUANTITY_CHECK_SQL, name=QUANTITY_CHECK),
    )
    op.create_index(INDEX_NAME, TABLE_NAME, ["invoice_id"])
    op.execute(BACKFILL_SQL)


def downgrade() -> None:
    # `drop_table` снимает и индекс: отдельный `drop_index` упал бы на повторном
    # прогоне отката.
    op.drop_table(TABLE_NAME)
