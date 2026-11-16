"""Цвета строк и столбцов в сохранённых шаблонах общего отчёта."""

import sqlalchemy as sa

from alembic import op

revision = "0072_report_template_colors"
down_revision = "0071_report_metrics_and_blocks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "report_templates",
        sa.Column("colors", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("report_templates", "colors")
