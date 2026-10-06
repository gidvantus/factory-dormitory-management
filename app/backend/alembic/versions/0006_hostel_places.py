"""Помесячные хостелы и дневные данные вкладки «Места»."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_hostel_places"
down_revision: str | None = "0005_required_report_rows"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "hostels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dormitory_id", sa.Integer(), sa.ForeignKey("dormitories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("active_from_month", sa.Date(), nullable=False),
        sa.Column("active_until_month", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "active_until_month IS NULL OR active_until_month >= active_from_month",
            name="ck_hostel_month_order",
        ),
    )
    op.create_index("ix_hostels_dormitory_id", "hostels", ["dormitory_id"])
    op.create_table(
        "hostel_cells",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("hostel_id", sa.Integer(), sa.ForeignKey("hostels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("report_date", sa.Date(), nullable=False),
        sa.Column("field", sa.String(length=24), nullable=False),
        sa.Column("value", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("hostel_id", "report_date", "field", name="uq_hostel_cell_day_field"),
        sa.CheckConstraint("value >= 0", name="ck_hostel_cell_nonnegative"),
    )
    op.create_index("ix_hostel_cells_hostel_id", "hostel_cells", ["hostel_id"])


def downgrade() -> None:
    op.drop_index("ix_hostel_cells_hostel_id", table_name="hostel_cells")
    op.drop_table("hostel_cells")
    op.drop_index("ix_hostels_dormitory_id", table_name="hostels")
    op.drop_table("hostels")
