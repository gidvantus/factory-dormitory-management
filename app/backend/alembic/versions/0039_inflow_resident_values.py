"""Данные для будущего заселения сохраняются вместе со строкой притока."""

import sqlalchemy as sa
from alembic import op

revision = "0039_inflow_resident_values"
down_revision = "0038_outflow_eviction"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "personnel_inflow",
        sa.Column("resident_values", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("personnel_inflow", "resident_values")
