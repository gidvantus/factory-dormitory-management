"""Оформление и порядок рабочих таблиц."""

import sqlalchemy as sa
from alembic import op

revision = "0062_table_views"
down_revision = "0061_merge_local_notifications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "table_views",
        sa.Column(
            "organization_id",
            sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("scope", sa.String(64), primary_key=True),
        sa.Column("table_key", sa.String(120), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("state", sa.JSON(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("table_views")
