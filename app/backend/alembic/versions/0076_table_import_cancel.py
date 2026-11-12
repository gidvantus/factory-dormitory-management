"""Запрос отмены для очереди Excel-импорта."""

import sqlalchemy as sa

from alembic import op

revision = "0076_table_import_cancel"
down_revision = "0075_table_import_progress"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "table_import_progress",
        sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        """
        INSERT INTO table_import_progress (job_id, rows_processed, rows_total)
        SELECT id, 0, 0 FROM table_import_jobs WHERE status = 'pending'
        ON CONFLICT (job_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute("UPDATE table_import_jobs SET status = 'failed' WHERE status = 'cancelled'")
    op.drop_column("table_import_progress", "cancel_requested")
