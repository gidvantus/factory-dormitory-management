"""Новая таблица не меняет существующие записи и персональные настройки."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_builder_migration_preserves_previous_data() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0052_personnel_builder.py"
    spec = spec_from_file_location("builder_migration", path)
    assert spec and spec.loader
    migration: Any = module_from_spec(spec)
    spec.loader.exec_module(migration)
    metadata = sa.MetaData()
    organizations = sa.Table(
        "organizations", metadata, sa.Column("id", sa.Integer, primary_key=True)
    )
    preferences = sa.Table(
        "personnel_preferences",
        metadata,
        sa.Column("user_id", sa.Integer, primary_key=True),
        sa.Column("settings", sa.JSON),
    )
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(organizations.insert(), {"id": 1})
        connection.execute(
            preferences.insert(), {"user_id": 1, "settings": {"blocks": [{"title": "Мой блок"}]}}
        )
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        assert "personnel_builders" in sa.inspect(connection).get_table_names()
        assert connection.execute(sa.select(preferences.c.settings)).scalar_one() == {
            "blocks": [{"title": "Мой блок"}]
        }
        migration.downgrade()
        assert "personnel_builders" not in sa.inspect(connection).get_table_names()
        assert connection.execute(sa.select(preferences.c.settings)).scalar_one() == {
            "blocks": [{"title": "Мой блок"}]
        }
    engine.dispose()
