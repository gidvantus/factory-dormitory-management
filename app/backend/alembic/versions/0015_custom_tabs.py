"""Пользовательские вкладки общежитий."""

import sqlalchemy as sa
from alembic import op

revision = "0015_custom_tabs"
down_revision = "0014_merge_activation_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "custom_tabs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dormitory_id", sa.Integer(), sa.ForeignKey("dormitories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("table_created", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_custom_tabs_dormitory_id", "custom_tabs", ["dormitory_id"])
    op.create_table(
        "custom_tab_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("dormitory_id", sa.Integer(), sa.ForeignKey("dormitories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tab_id", sa.Integer(), sa.ForeignKey("custom_tabs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("custom_values", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_custom_tab_entries_dormitory_id", "custom_tab_entries", ["dormitory_id"])
    op.create_index("ix_custom_tab_entries_tab_id", "custom_tab_entries", ["tab_id"])


def downgrade() -> None:
    op.execute("DELETE FROM table_columns WHERE substr(table_key, 1, 7) = 'custom_'")
    op.drop_table("custom_tab_entries")
    op.drop_table("custom_tabs")
