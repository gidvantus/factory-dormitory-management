"""Очередь общего Excel-импорта."""

import sqlalchemy as sa

from alembic import op

revision = "0074_table_import_queue"
down_revision = "0073_standard_clear_list"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "table_import_jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("dormitory_id", sa.Integer(), sa.ForeignKey("dormitories.id", ondelete="CASCADE"), nullable=False),
        sa.Column("table_key", sa.String(32), nullable=False),
        sa.Column("actor_id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("impersonated", sa.Boolean(), nullable=False),
        sa.Column("from_date", sa.Date(), nullable=True),
        sa.Column("to_date", sa.Date(), nullable=True),
        sa.Column("checksum", sa.String(64), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("detail", sa.String(), nullable=True),
        sa.Column("rows_added", sa.Integer(), nullable=False),
        sa.Column("cells_added", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index(
        "ix_table_import_jobs_pending",
        "table_import_jobs",
        ["created_at", "id"],
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_table("table_import_jobs")
