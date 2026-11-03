"""Подвкладки персонала организации; прежние данные и настройки сохраняются."""

import sqlalchemy as sa

from alembic import op

revision = "0052_personnel_builder"
down_revision = "0051_cell_fill"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "personnel_builders",
        sa.Column(
            "organization_id",
            sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("state", sa.JSON(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("personnel_builders")
