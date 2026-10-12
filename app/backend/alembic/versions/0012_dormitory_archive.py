"""Статус архива общежития без удаления его данных."""

import sqlalchemy as sa
from alembic import op

revision = "0012_dormitory_archive"
down_revision = "0011_table_columns_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dormitories",
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("dormitories", "is_archived")
