"""Удалить решения по вахтам, сохранив даты проживания, связи и историю."""

import sqlalchemy as sa

from alembic import op

revision = "0041_remove_shift_decisions"
down_revision = "0040_custom_tab_options"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    decisions = sa.table("employee_decisions", sa.column("plan_id", sa.String()))
    plan_ids = list(
        connection.scalars(sa.select(decisions.c.plan_id).where(decisions.c.plan_id.is_not(None)))
    )
    op.drop_table("employee_decisions")
    # Только планы выезда, созданные удалёнными решениями. Их события остаются в истории.
    if plan_ids:
        plans = sa.table(
            "employee_plans", sa.column("id", sa.String()), sa.column("kind", sa.String())
        )
        connection.execute(
            plans.delete().where(plans.c.id.in_(plan_ids), plans.c.kind == "departure")
        )
    preferences = sa.table(
        "personnel_preferences",
        sa.column("user_id", sa.Integer()),
        sa.column("revision", sa.Integer()),
        sa.column("settings", sa.JSON()),
    )
    for row in connection.execute(sa.select(preferences)).mappings():
        settings = row["settings"]
        if not isinstance(settings, dict) or not isinstance(settings.get("lists"), list):
            continue
        removed_ids = {
            item.get("id")
            for item in settings["lists"]
            if isinstance(item, dict)
            and any(
                isinstance(rule, dict) and rule.get("field") == "shift_decision"
                for rule in item.get("column_filters", [])
            )
        }
        if not removed_ids:
            continue
        # Не расширяем прежнюю подборку молча, убирая одно из её условий.
        updated = {
            **settings,
            "lists": [
                item
                for item in settings["lists"]
                if not isinstance(item, dict) or item.get("id") not in removed_ids
            ],
        }
        if isinstance(settings.get("blocks"), list):
            updated["blocks"] = [
                block
                for block in settings["blocks"]
                if not isinstance(block, dict)
                or block.get("kind") != "saved"
                or block.get("saved_list_id") not in removed_ids
            ]
        connection.execute(
            preferences.update()
            .where(preferences.c.user_id == row["user_id"])
            .values(settings=updated, revision=row["revision"] + 1)
        )


def downgrade() -> None:
    # Данные решений и удалённые подборки восстанавливаются из резервной копии.
    op.create_table(
        "employee_decisions",
        sa.Column(
            "resident_id",
            sa.Integer(),
            sa.ForeignKey("residents.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("employee_id", sa.String(36), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("date", sa.Date()),
        sa.Column("original_end", sa.Date()),
        sa.Column("comment", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "plan_id", sa.String(36), sa.ForeignKey("employee_plans.id", ondelete="SET NULL")
        ),
    )
    op.create_index("ix_employee_decisions_employee_id", "employee_decisions", ["employee_id"])
