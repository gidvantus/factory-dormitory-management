"""Сохранённые соответствия столбцов при переносе строк."""

import sqlalchemy as sa

from alembic import op

revision = "0080_transfer_column_mappings"
down_revision = "0079_hostel_occupancy_dates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dormitories",
        sa.Column("transfer_column_mappings", sa.JSON(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("dormitories", "transfer_column_mappings")
