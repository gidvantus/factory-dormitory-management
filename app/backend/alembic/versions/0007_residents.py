"""Таблица проживающих."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_residents"
down_revision: str | None = "0006_hostel_places"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "residents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("gender", sa.String(length=1)),
        sa.Column("personnel_number", sa.String(length=40)),
        sa.Column("full_name", sa.String(length=255)),
        sa.Column("hostel_id", sa.Integer(), sa.ForeignKey("hostels.id", ondelete="SET NULL")),
        sa.Column("shift_start", sa.Date()),
        sa.Column("shift_count", sa.Integer()),
        sa.Column("shift_end", sa.Date()),
        sa.Column("phone", sa.String(length=30)),
        sa.Column("medical_book", sa.String(length=12)),
        sa.Column("notes", sa.Text()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "shift_count IS NULL OR shift_count >= 0", name="ck_resident_shift_count"
        ),
    )
    op.create_index("ix_residents_dormitory_id", "residents", ["dormitory_id"])
    op.create_index("ix_residents_hostel_id", "residents", ["hostel_id"])


def downgrade() -> None:
    op.drop_index("ix_residents_hostel_id", table_name="residents")
    op.drop_index("ix_residents_dormitory_id", table_name="residents")
    op.drop_table("residents")
