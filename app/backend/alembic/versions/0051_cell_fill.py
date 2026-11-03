"""Правила заполнения ячеек; ручные значения существующих строк сохраняются."""

from alembic import op
import sqlalchemy as sa

revision = "0051_cell_fill"
down_revision = "0050_arrival_workflow"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("table_columns", sa.Column("fill", sa.JSON(), nullable=True))
    for name in ("fill_selections", "fill_copies"):
        op.add_column("custom_tab_entries", sa.Column(name, sa.JSON(), nullable=False, server_default="{}"))


def downgrade() -> None:
    op.drop_column("custom_tab_entries", "fill_copies")
    op.drop_column("custom_tab_entries", "fill_selections")
    op.drop_column("table_columns", "fill")
