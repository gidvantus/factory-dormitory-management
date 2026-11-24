"""Привязка изменений состава к действующему проживанию."""

import sqlalchemy as sa

from alembic import op

revision = "0079_hostel_occupancy_dates"
down_revision = "0078_hostel_resident_filters"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("hostel_occupancy_changes", sa.Column("resident_id", sa.Integer()))
    op.create_index(
        "ix_hostel_occupancy_changes_resident_id", "hostel_occupancy_changes", ["resident_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_hostel_occupancy_changes_resident_id", table_name="hostel_occupancy_changes")
    op.drop_column("hostel_occupancy_changes", "resident_id")
