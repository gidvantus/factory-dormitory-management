"""Индивидуальные строки отчётов и значения ячеек по дням."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_reports"
down_revision: str | None = "0002_dormitories"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "report_rows",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("dormitory_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("formula", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.ForeignKeyConstraint(["dormitory_id"], ["dormitories.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("dormitory_id", "name", name="uq_report_rows_dorm_name"),
    )
    op.create_index("ix_report_rows_dormitory_id", "report_rows", ["dormitory_id"])
    op.create_table(
        "report_cells",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("row_id", sa.Integer(), nullable=False),
        sa.Column("report_date", sa.Date(), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.ForeignKeyConstraint(["row_id"], ["report_rows.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("row_id", "report_date", name="uq_report_cells_row_date"),
    )
    op.create_index("ix_report_cells_row_id", "report_cells", ["row_id"])


def downgrade() -> None:
    op.drop_index("ix_report_cells_row_id", table_name="report_cells")
    op.drop_table("report_cells")
    op.drop_index("ix_report_rows_dormitory_id", table_name="report_rows")
    op.drop_table("report_rows")
