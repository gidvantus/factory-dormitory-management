"""Удалить задачи персонала и их блоки, сохранив остальные настройки и историю."""

import sqlalchemy as sa
from alembic import op

revision = "0031_remove_personnel_tasks"
down_revision = "0030_pricing_plans"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    preferences = sa.table(
        "personnel_preferences",
        sa.column("user_id", sa.Integer()),
        sa.column("revision", sa.Integer()),
        sa.column("settings", sa.JSON()),
    )
    for row in connection.execute(sa.select(preferences)).mappings():
        settings = row["settings"]
        blocks = settings.get("blocks") if isinstance(settings, dict) else None
        if not isinstance(blocks, list):
            continue
        remaining = [
            block for block in blocks if not isinstance(block, dict) or block.get("kind") != "tasks"
        ]
        if len(remaining) != len(blocks):
            connection.execute(
                preferences.update()
                .where(preferences.c.user_id == row["user_id"])
                .values(settings={**settings, "blocks": remaining}, revision=row["revision"] + 1)
            )
    events = sa.table("employee_events", sa.column("kind", sa.String()))
    connection.execute(events.delete().where(events.c.kind == "task"))
    op.drop_table("employee_tasks")


def downgrade() -> None:
    # Откат схемы не восстанавливает удалённые задачи: для данных нужна резервная копия.
    op.create_table(
        "employee_tasks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("employee_id", sa.String(36), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("text", sa.String(300), nullable=False),
        sa.Column("due", sa.Date(), nullable=False),
        sa.Column("assignee_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_employee_tasks_employee_id", "employee_tasks", ["employee_id"])
