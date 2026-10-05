"""Общежития: название, клиент и автор создания."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_dormitories"
down_revision: str | None = "0001_users"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dormitories",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("client_name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_dormitories_created_by_id", "dormitories", ["created_by_id"])


def downgrade() -> None:
    op.drop_index("ix_dormitories_created_by_id", table_name="dormitories")
    op.drop_table("dormitories")
