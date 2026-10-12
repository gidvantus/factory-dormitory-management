"""Настраиваемые столбцы, архив и связи большого отчёта."""

import sqlalchemy as sa
from alembic import op

revision = "0011_table_columns_links"
down_revision = "0010_payment_entries"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("residents", "personnel_inflow", "personnel_outflow", "payment_entries"):
        op.add_column(table, sa.Column("custom_values", sa.JSON(), nullable=False, server_default="{}"))
    op.add_column("report_rows", sa.Column("link", sa.JSON(), nullable=True))
    op.add_column("report_template_rows", sa.Column("link_snapshot", sa.JSON(), nullable=True))
    op.create_table(
        "table_columns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dormitory_id", sa.Integer(), sa.ForeignKey("dormitories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("table_key", sa.String(32), nullable=False),
        sa.Column("builtin_key", sa.String(40)),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("options", sa.JSON(), nullable=False),
        sa.Column("archived", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("dormitory_id", "table_key", "builtin_key", name="uq_table_builtin"),
    )
    op.create_index("ix_table_columns_dormitory_id", "table_columns", ["dormitory_id"])
    op.create_table(
        "archive_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dormitory_id", sa.Integer(), sa.ForeignKey("dormitories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("custom_values", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_archive_entries_dormitory_id", "archive_entries", ["dormitory_id"])


def downgrade() -> None:
    op.drop_table("archive_entries")
    op.drop_table("table_columns")
    op.drop_column("report_template_rows", "link_snapshot")
    op.drop_column("report_rows", "link")
    for table in ("residents", "personnel_inflow", "personnel_outflow", "payment_entries"):
        op.drop_column(table, "custom_values")
