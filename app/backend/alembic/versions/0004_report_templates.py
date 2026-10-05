"""Общие шаблоны структуры большого отчёта."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_report_templates"
down_revision: str | None = "0003_reports"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "report_templates",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False, unique=True),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="SET NULL"),
    )
    op.create_table(
        "report_template_rows",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("template_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("formula", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["template_id"], ["report_templates.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("template_id", "name", name="uq_report_template_rows_name"),
    )
    op.create_index("ix_report_template_rows_template_id", "report_template_rows", ["template_id"])


def downgrade() -> None:
    op.drop_index("ix_report_template_rows_template_id", table_name="report_template_rows")
    op.drop_table("report_template_rows")
    op.drop_table("report_templates")
