"""Обычные вкладки и прежние данные сохраняются после добавления типа Архив."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_archive_tabs_migration_preserves_existing_tabs_and_values() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0053_archive_tabs.py"
    spec = spec_from_file_location("archive_tabs_migration", path)
    assert spec and spec.loader
    migration: Any = module_from_spec(spec)
    spec.loader.exec_module(migration)
    metadata = sa.MetaData()
    sa.Table("dormitories", metadata, sa.Column("id", sa.Integer, primary_key=True))
    tabs = sa.Table(
        "custom_tabs",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String),
        sa.Column("options", sa.JSON),
    )
    entries = sa.Table(
        "archive_entries",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("custom_values", sa.JSON),
    )
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(
            tabs.insert(), {"id": 1, "name": "Архивные данные", "options": {"add_row": True}}
        )
        connection.execute(entries.insert(), {"id": 7, "custom_values": {"1": "Петров"}})
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        updated = sa.Table("custom_tabs", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(updated)).mappings().one()
        assert row["kind"] == "table"
        assert row["name"] == "Архивные данные" and row["options"] == {"add_row": True}
        assert connection.execute(sa.select(entries.c.custom_values)).scalar_one() == {
            "1": "Петров"
        }
        history = sa.Table("dormitory_data_events", sa.MetaData(), autoload_with=connection)
        assert connection.execute(sa.select(sa.func.count()).select_from(history)).scalar_one() == 0
        migration.downgrade()
        restored = sa.Table("custom_tabs", sa.MetaData(), autoload_with=connection)
        assert set(restored.c.keys()) == {"id", "name", "options"}
        assert connection.execute(sa.select(entries.c.custom_values)).scalar_one() == {
            "1": "Петров"
        }
    engine.dispose()
