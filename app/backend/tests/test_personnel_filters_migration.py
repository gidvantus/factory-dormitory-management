"""Очистка фильтров меняет только связанные пользовательские настройки."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_removed_filters_lists_blocks_and_favorites_are_cleaned_without_changing_history() -> None:
    path = (
        Path(__file__).resolve().parents[1] / "alembic/versions/0034_simplify_personnel_filters.py"
    )
    spec = spec_from_file_location("personnel_filters_migration", path)
    assert spec and spec.loader
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    metadata = sa.MetaData()
    preferences = sa.Table(
        "personnel_preferences",
        metadata,
        sa.Column("user_id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer()),
        sa.Column("settings", sa.JSON()),
    )
    records = [
        sa.Table(
            name,
            metadata,
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("data", sa.JSON()),
        )
        for name in (
            "employees",
            "employee_events",
            "employee_notes",
            "arrival_plans",
            "residents",
            "outflows",
        )
    ]
    kept_lists = [{"id": name, "filter": name} for name in ("all", "current", "ending")]
    removed_lists = [{"id": name, "filter": name} for name in sorted(migration.REMOVED_FILTERS)]
    kept_blocks = [
        {"id": name, "kind": name} for name in ("residents", "ending", "contacts", "plans")
    ]
    kept_blocks.append({"id": "kept-list", "kind": "saved", "saved_list_id": "current"})
    old_blocks = [
        *kept_blocks,
        {"id": "outflow", "kind": "outflow"},
        {"id": "missing", "kind": "missing"},
    ]
    old_blocks.extend(
        {"id": "saved-" + item["id"], "kind": "saved", "saved_list_id": item["id"]}
        for item in removed_lists
    )
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        metadata.create_all(connection)
        migration.__dict__["op"] = Operations(MigrationContext.configure(connection))
        settings = {
            "blocks": old_blocks,
            "lists": [*kept_lists, *removed_lists],
            "favorites": ["person"],
            "future_setting": True,
        }
        clean = {"blocks": kept_blocks, "lists": kept_lists, "future_setting": True}
        connection.execute(
            preferences.insert(),
            [
                {"user_id": 1, "revision": 7, "settings": settings},
                {"user_id": 2, "revision": 7, "settings": clean},
                {
                    "user_id": 3,
                    "revision": 7,
                    "settings": {"blocks": None, "lists": [], "favorites": []},
                },
                {"user_id": 4, "revision": 7, "settings": {"blocks": [], "lists": []}},
            ],
        )
        for table in records:
            connection.execute(table.insert().values(id="kept", data={"text": "История сохранена"}))
        migration.upgrade()
        rows = list(
            connection.execute(sa.select(preferences).order_by(preferences.c.user_id)).mappings()
        )
        assert rows[0]["settings"] == clean
        assert rows[1]["settings"] == clean
        assert rows[2]["settings"] == {"blocks": None, "lists": []}
        assert rows[3]["settings"] == {"blocks": [], "lists": []}
        assert [row["revision"] for row in rows] == [8, 7, 8, 7]
        migration.upgrade()
        assert list(
            connection.scalars(sa.select(preferences.c.revision).order_by(preferences.c.user_id))
        ) == [8, 7, 8, 7]
        migration.downgrade()
        assert all(
            row[0]["favorites"] == []
            for row in connection.execute(sa.select(preferences.c.settings))
        )
        migration.upgrade()
        assert (
            connection.scalar(sa.select(preferences.c.settings).where(preferences.c.user_id == 1))
            == clean
        )
        for table in records:
            assert list(connection.execute(sa.select(table))) == [
                ("kept", {"text": "История сохранена"})
            ]
    engine.dispose()
