"""Таблица притока персонала."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008_personnel_inflow"
down_revision: str | None = "0007_residents"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "personnel_inflow",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("settlement_date", sa.Date()),
        sa.Column("personnel_number", sa.String(length=40)),
        sa.Column("full_name", sa.String(length=255)),
        sa.Column("citizenship", sa.String(length=120)),
        sa.Column("notes", sa.Text()),
        sa.Column("shift_count", sa.Integer()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("shift_count IS NULL OR shift_count >= 0", name="ck_inflow_shift_count"),
    )
    op.create_index("ix_personnel_inflow_dormitory_id", "personnel_inflow", ["dormitory_id"])
    op.create_index("ix_personnel_inflow_settlement_date", "personnel_inflow", ["settlement_date"])


def downgrade() -> None:
    op.drop_index("ix_personnel_inflow_settlement_date", table_name="personnel_inflow")
    op.drop_index("ix_personnel_inflow_dormitory_id", table_name="personnel_inflow")
    op.drop_table("personnel_inflow")
