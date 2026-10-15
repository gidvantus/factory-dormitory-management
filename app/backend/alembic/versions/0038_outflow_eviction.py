"""Сохранение завершённого выселения в журнале оттока."""

import sqlalchemy as sa
from alembic import op

revision = "0038_outflow_eviction"
down_revision = "0037_merge_develop_s"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "personnel_outflow", sa.Column("evicted_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("personnel_outflow", "evicted_at")
