"""Настройки импорта и экспорта стандартных вкладок; записи не изменяются."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0059_table_exchange"
down_revision: str | None = "0058_merge_main_heads"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "dormitories",
        sa.Column("exchange_options", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("dormitories", "exchange_options")
