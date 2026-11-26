"""Сохранить формат формульных строк общего отчёта и его шаблонов."""

import sqlalchemy as sa
from alembic import op

revision = "0083_formula_display_percent"
down_revision = "0082_merge_personnel_transfer"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("report_rows", "report_template_rows"):
        op.add_column(
            table,
            sa.Column("display_percent", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    for table in ("report_template_rows", "report_rows"):
        op.drop_column(table, "display_percent")
