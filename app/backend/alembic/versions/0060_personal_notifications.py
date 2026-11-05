"""Личные уведомления: настройки, расписание и отложенные события."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0060_personal_notifications"
down_revision: str | None = "0059_table_exchange"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "personal_notifications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("config", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("observed", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("pending", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("next_run_at", sa.DateTime(timezone=True)),
        sa.Column("scheduled_for", sa.DateTime(timezone=True)),
        sa.Column("last_run_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.String(255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    for column in ("user_id", "organization_id", "next_run_at"):
        op.create_index(f"ix_personal_notifications_{column}", "personal_notifications", [column])


def downgrade() -> None:
    op.drop_table("personal_notifications")
