"""Тип подвкладки «Архив» и история изменений данных общежития."""

import sqlalchemy as sa
from alembic import op

revision = "0053_archive_tabs"
down_revision = "0052_personnel_builder"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "custom_tabs", sa.Column("kind", sa.String(16), nullable=False, server_default="table")
    )
    op.create_table(
        "dormitory_data_events",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            primary_key=True,
            autoincrement=True,
        ),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("actor_id", sa.Integer(), nullable=False),
        sa.Column("actor_name", sa.String(255), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
    )
    op.create_index(
        "ix_dormitory_history_page", "dormitory_data_events", ["dormitory_id", "created_at", "id"]
    )


def downgrade() -> None:
    op.drop_table("dormitory_data_events")
    op.drop_column("custom_tabs", "kind")
