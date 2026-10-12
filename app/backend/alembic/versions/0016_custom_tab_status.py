"""Скрытие пользовательских вкладок без удаления их данных."""

import sqlalchemy as sa
from alembic import op

revision = "0016_custom_tab_status"
down_revision = "0015_custom_tabs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "custom_tabs",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column("custom_tabs", "is_active")
