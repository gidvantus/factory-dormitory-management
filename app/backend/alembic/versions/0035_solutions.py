"""Магазин улучшений: каталог решений, права организаций и второй вид счёта.

Ревизия аддитивная: две новые таблицы, две новые колонки в `invoices` —
`solution_id` (nullable, `SET NULL`) и `item_kind` (`NOT NULL` с
`server_default='tariff'`). Ни одна строка существующих данных не переписывается:
у всех выставленных ранее счетов `item_kind` становится `'tariff'`, потому что
иных предметов до этой ревизии не было.

Порядок в `downgrade()` обратный и важен: колонки счёта снимаются **до** удаления
`solutions`, иначе внешний ключ не даст удалить таблицу. Прежние счета, тарифы и
привязки организаций откат не трогает — он снимает ровно то, что добавил
`upgrade()`.

Голова на момент ревизии — `0034_merge_telegram`. В дереве уже четыре сводящие
ревизии, второй головы быть не должно: этот шаг встаёт поверх текущей головы, а
не поверх `0032_telegram_notifications`.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`.

Значения записаны прямо в SQL, а не взяты из `app.models.solution`: миграция
должна читаться и исполняться без импорта приложения, иначе правка модели задним
числом меняет смысл уже выпущенной ревизии. Набор периодов — тот же, что у
тарифов (`TARIFF_PERIODS`): `'month', 'year', 'once', 'half_year'`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0035_solutions"
down_revision: str | None = "0034_merge_telegram"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PERIODS_SQL = "'month', 'year', 'once', 'half_year'"
ITEM_KINDS_SQL = "'tariff', 'solution'"

SOLUTIONS_INDEXES = (
    "ix_organization_solutions_organization_id",
    "ix_organization_solutions_solution_id",
)
INVOICES_SOLUTION_INDEX = "ix_invoices_solution_id"

# Строка каталога, которую заводит эта ревизия: ровно одно решение — уведомления
# в Telegram. Вставка идемпотентна по `code`: параметр встречается в запросе
# ровно один раз (проверка существующих кодов идёт отдельным запросом), иначе
# PostgreSQL разбирает `INSERT ... WHERE NOT EXISTS` до вывода типов и падает с
# `AmbiguousParameter` — тем же приёмом это сделано в `0030_pricing_plans`.
SEED = {
    "code": "telegram_notifications",
    "name": "Уведомления в Telegram",
    "description": "Сообщения о событиях, которые вас касаются",
    "amount": "500.00",
    "currency": "RUB",
    "period": "month",
    "position": 1,
}

EXISTING_CODES_SQL = sa.text("SELECT code FROM solutions")

INSERT_SOLUTION_SQL = sa.text(
    """
    INSERT INTO solutions (code, name, description, amount, currency, period, position, is_visible)
    VALUES (:code, :name, :description, :amount, :currency, :period, :position, true)
    """
)

DELETE_SOLUTION_SQL = sa.text("DELETE FROM solutions WHERE code = :code")


def upgrade() -> None:
    op.create_table(
        "solutions",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("code", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("amount", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default="RUB"),
        sa.Column("period", sa.String(length=10), nullable=False, server_default="month"),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_visible", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("code", name="uq_solutions_code"),
        sa.UniqueConstraint("name", name="uq_solutions_name"),
        sa.CheckConstraint("amount >= 0", name="ck_solutions_amount_non_negative"),
        sa.CheckConstraint(f"period IN ({PERIODS_SQL})", name="ck_solutions_period"),
    )

    op.create_table(
        "organization_solutions",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("solution_id", sa.Integer(), nullable=False),
        sa.Column(
            "granted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invoice_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name="fk_organization_solutions_organization_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["solution_id"],
            ["solutions.id"],
            name="fk_organization_solutions_solution_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["invoice_id"],
            ["invoices.id"],
            name="fk_organization_solutions_invoice_id",
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint(
            "organization_id",
            "solution_id",
            name="uq_organization_solutions_organization_solution",
        ),
    )
    op.create_index(SOLUTIONS_INDEXES[0], "organization_solutions", ["organization_id"])
    op.create_index(SOLUTIONS_INDEXES[1], "organization_solutions", ["solution_id"])

    # `batch_alter_table` нужен из-за SQLite: там нет `ALTER TABLE ... ADD
    # CONSTRAINT`, и Alembic пересоздаёт таблицу копированием. На Postgres
    # батч-режим вырождается в обычные `ALTER TABLE ... ADD COLUMN/ADD
    # CONSTRAINT` (как в `0015_organization_roles`).
    with op.batch_alter_table("invoices") as batch_op:
        batch_op.add_column(sa.Column("solution_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column("item_kind", sa.String(length=10), nullable=False, server_default="tariff")
        )
        batch_op.create_foreign_key(
            "fk_invoices_solution_id",
            "solutions",
            ["solution_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index(INVOICES_SOLUTION_INDEX, ["solution_id"])
        batch_op.create_check_constraint(
            "ck_invoices_item_kind", f"item_kind IN ({ITEM_KINDS_SQL})"
        )

    connection = op.get_bind()
    existing = set(connection.execute(EXISTING_CODES_SQL).scalars())
    if SEED["code"] not in existing:
        connection.execute(INSERT_SOLUTION_SQL, SEED)


def downgrade() -> None:
    # Сначала счёт: пока `invoices.solution_id` ссылается на `solutions`, удалить
    # таблицу каталога нельзя.
    with op.batch_alter_table("invoices") as batch_op:
        batch_op.drop_constraint("ck_invoices_item_kind", type_="check")
        batch_op.drop_index(INVOICES_SOLUTION_INDEX)
        batch_op.drop_constraint("fk_invoices_solution_id", type_="foreignkey")
        batch_op.drop_column("item_kind")
        batch_op.drop_column("solution_id")

    op.get_bind().execute(DELETE_SOLUTION_SQL, {"code": SEED["code"]})

    op.drop_index(SOLUTIONS_INDEXES[1], table_name="organization_solutions")
    op.drop_index(SOLUTIONS_INDEXES[0], table_name="organization_solutions")
    op.drop_table("organization_solutions")
    op.drop_table("solutions")
