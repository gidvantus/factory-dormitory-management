"""Списки записи на аванс и расчёт."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010_payment_entries"
down_revision: str | None = "0009_personnel_outflow"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "payment_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("personnel_number", sa.String(length=40)),
        sa.Column("full_name", sa.String(length=255)),
        sa.Column("advance_amount", sa.Numeric(precision=12, scale=2)),
        sa.Column("settlement_date", sa.Date()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("kind IN ('advance', 'settlement')", name="ck_payment_entry_kind"),
        sa.CheckConstraint(
            "advance_amount IS NULL OR advance_amount >= 0", name="ck_payment_entry_amount"
        ),
    )
    op.create_index("ix_payment_entries_dormitory_id", "payment_entries", ["dormitory_id"])
    op.create_index("ix_payment_entries_kind_date", "payment_entries", ["kind", "settlement_date"])


def downgrade() -> None:
    op.drop_index("ix_payment_entries_kind_date", table_name="payment_entries")
    op.drop_index("ix_payment_entries_dormitory_id", table_name="payment_entries")
    op.drop_table("payment_entries")
