"""Связь записи выплаты с проживающим для защиты от повторной записи."""

import sqlalchemy as sa
from alembic import op

revision = "0013_resident_payments"
down_revision = "0012_dormitory_archive"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("payment_entries", sa.Column("source_resident_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_payment_source_resident",
        "payment_entries",
        "residents",
        ["source_resident_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_payment_entries_source_resident_id", "payment_entries", ["source_resident_id"])
    op.create_unique_constraint(
        "uq_payment_source_resident", "payment_entries", ["dormitory_id", "kind", "source_resident_id"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_payment_source_resident", "payment_entries", type_="unique")
    op.drop_index("ix_payment_entries_source_resident_id", table_name="payment_entries")
    op.drop_constraint("fk_payment_source_resident", "payment_entries", type_="foreignkey")
    op.drop_column("payment_entries", "source_resident_id")
