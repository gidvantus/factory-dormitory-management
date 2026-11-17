"""Настройки строк, шаблоны хостелов и история численности."""

import sqlalchemy as sa

from alembic import context, op

revision = "0077_hostel_builder"
down_revision = "0076_table_import_cancel"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("hostels", sa.Column("layouts", sa.JSON(), nullable=False, server_default="{}"))
    op.add_column(
        "hostels", sa.Column("layout_version", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "hostels",
        sa.Column("occupancy_since", sa.Date(), nullable=False, server_default="1970-01-01"),
    )
    dialect = context.get_context().dialect.name
    today = (
        "CAST(timezone('Europe/Moscow', CURRENT_TIMESTAMP) AS date)"
        if dialect == "postgresql"
        else "CURRENT_DATE"
    )
    op.execute(f"UPDATE hostels SET occupancy_since = {today}")
    if dialect != "sqlite":
        op.alter_column("hostels", "occupancy_since", server_default=None)
    op.create_table(
        "hostel_templates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False,
        ),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("name_key", sa.String(360), nullable=False),
        sa.Column("rows", sa.JSON(), nullable=False),
        sa.UniqueConstraint("organization_id", "name_key", name="uq_hostel_template_name"),
    )
    op.create_index("ix_hostel_templates_organization_id", "hostel_templates", ["organization_id"])
    op.create_table(
        "hostel_occupancy_changes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "hostel_id", sa.Integer(),
            sa.ForeignKey("hostels.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("men", sa.Integer(), nullable=False),
        sa.Column("women", sa.Integer(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
    )
    op.create_index("ix_hostel_occupancy_day", "hostel_occupancy_changes", ["hostel_id", "day"])


def downgrade() -> None:
    op.drop_table("hostel_occupancy_changes")
    op.drop_table("hostel_templates")
    op.drop_column("hostels", "occupancy_since")
    op.drop_column("hostels", "layout_version")
    op.drop_column("hostels", "layouts")
