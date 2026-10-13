"""Простой план заездов по общежитиям и датам."""

from collections import defaultdict
from datetime import date
from uuid import uuid4

import sqlalchemy as sa

from alembic import op

revision = "0032_arrival_plans"
down_revision = "0031_remove_personnel_tasks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    table = op.create_table(
        "arrival_plans",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.Column("names", sa.JSON(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("dormitory_id", "date", name="uq_arrival_plan_dormitory_date"),
        sa.CheckConstraint("count > 0", name="ck_arrival_plan_positive_count"),
    )
    op.create_index("ix_arrival_plans_dormitory_id", "arrival_plans", ["dormitory_id"])
    op.create_index("ix_arrival_plans_date", "arrival_plans", ["date"])
    connection = op.get_bind()
    # Копируем прежние индивидуальные заезды. Исходные записи и история сохраняются.
    rows = connection.execute(
        sa.text(
            "SELECT p.dormitory_id, p.date, e.full_name FROM employee_plans p "
            "JOIN employees e ON e.id = p.employee_id WHERE p.kind = 'arrival' ORDER BY p.id"
        )
    )
    grouped: dict[tuple, list[str | None]] = defaultdict(list)
    for dormitory_id, day, name in rows:
        if isinstance(day, str):
            day = date.fromisoformat(day)
        grouped[dormitory_id, day].append(name)
    for (dormitory_id, day), names in grouped.items():
        connection.execute(
            table.insert().values(
                id=str(uuid4()),
                dormitory_id=dormitory_id,
                date=day,
                count=len(names),
                names=[name for name in names if name and name.strip()],
                revision=0,
            )
        )
    preferences = sa.table(
        "personnel_preferences",
        sa.column("user_id", sa.Integer()),
        sa.column("revision", sa.Integer()),
        sa.column("settings", sa.JSON()),
    )
    for row in connection.execute(sa.select(preferences)).mappings():
        settings = row["settings"]
        if not isinstance(settings, dict):
            continue
        updated = dict(settings)
        if isinstance(settings.get("lists"), list):
            updated["lists"] = [
                {**item, "filter": "all"}
                if isinstance(item, dict) and item.get("filter") == "arrivals"
                else item
                for item in settings["lists"]
            ]
        if isinstance(settings.get("blocks"), list):
            updated["blocks"] = [
                {**block, "title": "План заездов"}
                if isinstance(block, dict)
                and block.get("kind") == "plans"
                and block.get("title") == "План заездов и выездов"
                else block
                for block in settings["blocks"]
            ]
        if updated != settings:
            connection.execute(
                preferences.update()
                .where(preferences.c.user_id == row["user_id"])
                .values(settings=updated, revision=row["revision"] + 1)
            )


def downgrade() -> None:
    op.drop_table("arrival_plans")
