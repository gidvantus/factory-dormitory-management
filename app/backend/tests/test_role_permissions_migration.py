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
