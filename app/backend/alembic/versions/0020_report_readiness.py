"""Ежедневные отметки готовности отчётов."""

import sqlalchemy as sa
from alembic import op

revision = "0020_report_readiness"
down_revision = "0019_dormitory_templates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "report_readiness",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("report_date", sa.Date(), nullable=False),
        sa.Column("is_ready", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("confirmed_at", sa.DateTime(timezone=True)),
        sa.Column("confirmed_by_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.UniqueConstraint("dormitory_id", "report_date"),
    )
    op.create_index("ix_report_readiness_dormitory_id", "report_readiness", ["dormitory_id"])


def downgrade() -> None:
    op.drop_table("report_readiness")
