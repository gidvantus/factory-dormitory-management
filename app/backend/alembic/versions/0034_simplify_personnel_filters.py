"""Удалить ненужные фильтры персонала и их пользовательские настройки."""

import sqlalchemy as sa

from alembic import op

revision = "0034_simplify_personnel_filters"
down_revision = "0033_merge_develop_s"
branch_labels = None
depends_on = None

REMOVED_FILTERS = {"overdue", "missing", "history", "mine", "returned", "no-phone", "pending"}


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
        if not isinstance(settings, dict):
            continue
        updated = dict(settings)
        updated.pop("favorites", None)
        removed_lists = set()
        if isinstance(settings.get("lists"), list):
            removed_lists = {
                item.get("id")
                for item in settings["lists"]
                if isinstance(item, dict) and item.get("filter") in REMOVED_FILTERS
            }
            updated["lists"] = [
                item
                for item in settings["lists"]
                if not isinstance(item, dict) or item.get("filter") not in REMOVED_FILTERS
            ]
        if isinstance(settings.get("blocks"), list):
            updated["blocks"] = [
                block
                for block in settings["blocks"]
                if not isinstance(block, dict)
                or (
                    block.get("kind") not in {"outflow", "missing"}
                    and not (
                        block.get("kind") == "saved" and block.get("saved_list_id") in removed_lists
                    )
                )
            ]
        if updated != settings:
            connection.execute(
                preferences.update()
                .where(preferences.c.user_id == row["user_id"])
                .values(settings=updated, revision=row["revision"] + 1)
            )


def downgrade() -> None:
    # Прежнему интерфейсу нужен ключ favorites. Удалённые подборки и избранное
    # восстанавливаются только из резервной копии, а не из данных сотрудников.
    connection = op.get_bind()
    preferences = sa.table(
        "personnel_preferences",
        sa.column("user_id", sa.Integer()),
        sa.column("revision", sa.Integer()),
        sa.column("settings", sa.JSON()),
    )
    for row in connection.execute(sa.select(preferences)).mappings():
        settings = row["settings"]
        if isinstance(settings, dict) and "favorites" not in settings:
            connection.execute(
                preferences.update()
                .where(preferences.c.user_id == row["user_id"])
                .values(settings={**settings, "favorites": []}, revision=row["revision"] + 1)
            )
