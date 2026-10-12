"""Снимки структуры общежития."""

import sqlalchemy as sa
from alembic import op

revision = "0019_dormitory_templates"
down_revision = "0018_all_tab_parents"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "dormitory_templates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), unique=True, nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("dormitory_templates")
