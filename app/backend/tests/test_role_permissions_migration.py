"""Миграция сохраняет прежний доступ и создаёт ровно три должности."""

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_migration_seeds_enabled_rights_and_can_be_reverted() -> None:
    path = Path(__file__).parents[1] / "alembic/versions/0069_role_permissions.py"
    spec = importlib.util.spec_from_file_location("role_permissions_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite:///:memory:")
    with (
        engine.begin() as connection,
        Operations.context(MigrationContext.configure(connection)),
    ):
        migration.upgrade()
        rows = connection.execute(
            sa.text(
                "SELECT role, import_enabled, export_enabled FROM role_permissions ORDER BY role"
            )
        ).all()
        assert rows == [("admin", 1, 1), ("commandant", 1, 1), ("manager", 1, 1)]
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text("INSERT INTO role_permissions (role) VALUES ('owner')"))
        migration.downgrade()
        assert "role_permissions" not in sa.inspect(connection).get_table_names()
    engine.dispose()


def test_sidebar_migration_preserves_exchange_settings_and_downgrades() -> None:
    def read_migration(filename: str):
        spec = importlib.util.spec_from_file_location(
            filename, Path(__file__).parents[1] / "alembic/versions" / filename
        )
        assert spec is not None and spec.loader is not None
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        return migration

    original = read_migration("0069_role_permissions.py")
    sidebar = read_migration("0070_sidebar_permissions.py")
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
        original.upgrade()
        connection.execute(
            sa.text("UPDATE role_permissions SET import_enabled = false WHERE role = 'manager'")
        )
        sidebar.upgrade()
        rows = connection.execute(sa.text("SELECT * FROM role_permissions")).mappings().all()
        assert len(rows) == 3 and all(all(row[field] for field in sidebar.FIELDS) for row in rows)
        assert next(row for row in rows if row["role"] == "manager")["import_enabled"] == 0
        sidebar.downgrade()
        assert {
            column["name"] for column in sa.inspect(connection).get_columns("role_permissions")
        } == {"role", "import_enabled", "export_enabled"}
    engine.dispose()
