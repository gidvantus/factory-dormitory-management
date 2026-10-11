"""Общие блоки статистики и порядок дашборда."""

import sqlalchemy as sa
from alembic import op

revision = "0021_dashboard_blocks"
down_revision = "0020_report_readiness"
branch_labels = None
depends_on = None


def upgrade() -> None:
    layout = op.create_table(
        "dashboard_layout",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("order", sa.JSON(), nullable=False),
        sa.Column("hidden", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
    )
    op.bulk_insert(
        layout,
        [
            {
                "id": 1,
                "revision": 0,
                "order": ["residents", "turnover", "attendance", "reports"],
                "hidden": [],
            }
        ],
    )
    op.create_table(
        "dashboard_blocks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
    )


def downgrade() -> None:
    op.drop_table("dashboard_blocks")
    op.drop_table("dashboard_layout")
