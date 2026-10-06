"""Таблица оттока персонала."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009_personnel_outflow"
down_revision: str | None = "0008_personnel_inflow"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "personnel_outflow",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("departure_date", sa.Date()),
        sa.Column("personnel_number", sa.String(length=40)),
        sa.Column("full_name", sa.String(length=255)),
        sa.Column("shift_start", sa.Date()),
        sa.Column("reason", sa.String(length=255)),
        sa.Column("notes", sa.Text()),
        sa.Column("additional_info", sa.Text()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_personnel_outflow_dormitory_id", "personnel_outflow", ["dormitory_id"])
    op.create_index("ix_personnel_outflow_departure_date", "personnel_outflow", ["departure_date"])


def downgrade() -> None:
    op.drop_index("ix_personnel_outflow_departure_date", table_name="personnel_outflow")
    op.drop_index("ix_personnel_outflow_dormitory_id", table_name="personnel_outflow")
    op.drop_table("personnel_outflow")
