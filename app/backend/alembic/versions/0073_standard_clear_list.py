"""Настройка очистки списков стандартных вкладок общежития."""

import sqlalchemy as sa

from alembic import op

revision = "0073_standard_clear_list"
down_revision = "0072_report_template_colors"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dormitories",
        sa.Column("standard_clear_list", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("dormitories", "standard_clear_list")
