"""Стандартные разделы и пользовательские подвкладки."""

import sqlalchemy as sa
from alembic import op

revision = "0017_tab_hierarchy"
down_revision = "0016_custom_tab_status"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dormitories",
        sa.Column("section_states", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.add_column("custom_tabs", sa.Column("parent_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_custom_tabs_parent",
        "custom_tabs",
        "custom_tabs",
        ["parent_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_custom_tabs_parent_id", "custom_tabs", ["parent_id"])
    op.add_column(
        "custom_tabs",
        sa.Column("is_group", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("custom_tabs", "is_group")
    op.drop_index("ix_custom_tabs_parent_id", table_name="custom_tabs")
    op.drop_constraint("fk_custom_tabs_parent", "custom_tabs", type_="foreignkey")
    op.drop_column("custom_tabs", "parent_id")
    op.drop_column("dormitories", "section_states")
