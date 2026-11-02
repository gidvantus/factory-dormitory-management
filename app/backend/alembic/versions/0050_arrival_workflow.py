"""Отметки людей и связь плана заездов с проживанием без изменения старых планов."""

from alembic import op
import sqlalchemy as sa

revision = "0050_arrival_workflow"
down_revision = "0049_arrival_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "arrival_visits",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("plan_id", sa.String(36), sa.ForeignKey("arrival_plans.id", ondelete="CASCADE"), nullable=False),
        sa.Column("person_id", sa.String(36), nullable=False),
        sa.Column("lineage_id", sa.String(36), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("arrived_on", sa.Date()),
        sa.Column("employee_id", sa.String(36), sa.ForeignKey("employees.id")),
        sa.Column("resident_id", sa.Integer(), sa.ForeignKey("residents.id", ondelete="SET NULL"), unique=True),
        sa.Column("origin", sa.JSON()),
        sa.Column("destination", sa.JSON()),
        sa.Column("previous_status", sa.String(16)),
        sa.Column("history", sa.JSON(), nullable=False),
        sa.Column("settlement", sa.JSON()),
        sa.UniqueConstraint("plan_id", "person_id", name="uq_arrival_visit_person"),
        sa.CheckConstraint("status IN ('expected','arrived','no_show','moved','settled')", name="ck_arrival_visit_status"),
    )
    for name in ("plan_id", "lineage_id", "employee_id"):
        op.create_index(f"ix_arrival_visits_{name}", "arrival_visits", [name])


def downgrade() -> None:
    op.drop_table("arrival_visits")
