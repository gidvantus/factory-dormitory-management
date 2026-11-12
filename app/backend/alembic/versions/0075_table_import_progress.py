"""Счётчик строк в фоновых заданиях Excel-импорта."""

import sqlalchemy as sa

from alembic import op

revision = "0075_table_import_progress"
down_revision = "0074_table_import_queue"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "table_import_progress",
        sa.Column(
            "job_id",
            sa.Uuid(),
            sa.ForeignKey("table_import_jobs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("rows_processed", sa.Integer(), nullable=False),
        sa.Column("rows_total", sa.Integer(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("table_import_progress")
