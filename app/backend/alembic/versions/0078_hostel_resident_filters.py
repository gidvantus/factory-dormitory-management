"""Настраиваемые варианты пола и история фильтров состава хостела."""

import sqlalchemy as sa

from alembic import context, op

revision = "0078_hostel_resident_filters"
down_revision = "0077_hostel_builder"
branch_labels = None
depends_on = None


def upgrade() -> None:
    dialect = context.get_context().dialect.name
    if dialect != "sqlite":
        op.alter_column("residents", "gender", existing_type=sa.String(1), type_=sa.String(64))
    op.add_column(
        "hostel_occupancy_changes",
        sa.Column("fields", sa.JSON(), nullable=False, server_default="{}"),
    )
    op.add_column(
        "hostels",
        sa.Column("resident_fields_since", sa.Date(), nullable=False, server_default="1970-01-01"),
    )
    if dialect == "postgresql":
        op.execute(
            "UPDATE hostels SET resident_fields_since = "
            "CAST(timezone('Europe/Moscow', CURRENT_TIMESTAMP) AS date)"
        )
        op.alter_column("hostels", "resident_fields_since", server_default=None)
    else:
        op.execute("UPDATE hostels SET resident_fields_since = CURRENT_DATE")


def downgrade() -> None:
    # Сохранённые идентификаторы дополнительных вариантов могут быть длиннее одного символа.
    op.drop_column("hostels", "resident_fields_since")
    op.drop_column("hostel_occupancy_changes", "fields")
