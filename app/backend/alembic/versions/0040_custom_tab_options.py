"""Настройки пользовательских вкладок и значения по дням."""

import sqlalchemy as sa
from alembic import op

revision = "0040_custom_tab_options"
down_revision = "0039_inflow_resident_values"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("custom_tabs", sa.Column("options", sa.JSON(), nullable=False, server_default="{}"))
    op.add_column(
        "custom_tab_entries",
        sa.Column("calendar_values", sa.JSON(), nullable=False, server_default="{}"),
    )


def downgrade() -> None:
    op.drop_column("custom_tab_entries", "calendar_values")
    op.drop_column("custom_tabs", "options")
