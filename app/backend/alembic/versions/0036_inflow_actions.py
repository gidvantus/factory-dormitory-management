"""Результат обработки притока сохраняется вместе с исходной записью."""

import sqlalchemy as sa
from alembic import op

revision = "0036_inflow_actions"
down_revision = "0035_outflow_reasons"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("personnel_inflow", sa.Column("processed_as", sa.String(16), nullable=True))
    op.add_column("personnel_inflow", sa.Column("processed_row_id", sa.Integer(), nullable=True))
    op.add_column(
        "personnel_inflow", sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("personnel_inflow", "processed_at")
    op.drop_column("personnel_inflow", "processed_row_id")
    op.drop_column("personnel_inflow", "processed_as")
