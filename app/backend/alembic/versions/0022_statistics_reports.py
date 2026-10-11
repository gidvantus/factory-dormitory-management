"""Сохранённые отчёты раздела статистики."""

import sqlalchemy as sa
from alembic import op

revision = "0022_statistics_reports"
down_revision = "0021_dashboard_blocks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "statistics_reports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("visibility", sa.String(12), nullable=False, server_default="shared"),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("blocks", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_statistics_reports_created_by_id", "statistics_reports", ["created_by_id"])


def downgrade() -> None:
    op.drop_table("statistics_reports")
