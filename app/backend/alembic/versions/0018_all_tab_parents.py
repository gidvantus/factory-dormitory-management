"""Подвкладки любого раздела и самостоятельные стандартные таблицы."""

import sqlalchemy as sa
from alembic import op

revision = "0018_all_tab_parents"
down_revision = "0017_tab_hierarchy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("custom_tabs", sa.Column("parent_section", sa.String(24), nullable=True))
    op.add_column(
        "dormitories",
        sa.Column("section_parents", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("dormitories", "section_parents")
    op.drop_column("custom_tabs", "parent_section")
