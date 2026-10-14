"""Сохранённые причины оттока для текстовых столбцов."""

import sqlalchemy as sa
from alembic import op

revision = "0035_outflow_reasons"
down_revision = "0034_simplify_personnel_filters"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "outflow_reasons",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "column_id",
            sa.Integer(),
            sa.ForeignKey("table_columns.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("normalized", sa.String(255), nullable=False),
        sa.Column("label", sa.String(255), nullable=False),
        sa.UniqueConstraint("column_id", "normalized", name="uq_outflow_reason"),
    )


def downgrade() -> None:
    op.drop_table("outflow_reasons")
