"""Обновление схемы не меняет прежние ручные значения, откат их сохраняет."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_cell_fill_migration_preserves_manual_data() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0051_cell_fill.py"
    spec = spec_from_file_location("cell_fill_migration", path)
    assert spec and spec.loader
    migration: Any = module_from_spec(spec)
    spec.loader.exec_module(migration)
    metadata = sa.MetaData()
    columns = sa.Table(
        "table_columns",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String),
    )
    rows = sa.Table(
        "custom_tab_entries",
        metadata,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("custom_values", sa.JSON),
    )
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(columns.insert(), {"id": 1, "name": "ФИО"})
        connection.execute(
            rows.insert(), {"id": 1, "custom_values": {"1": "Иванов", "2": "2026-10-01"}}
        )
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        after = sa.Table("custom_tab_entries", sa.MetaData(), autoload_with=connection)
        value = connection.execute(sa.select(after)).mappings().one()
        assert value["custom_values"] == {"1": "Иванов", "2": "2026-10-01"}
        assert value["fill_selections"] == value["fill_copies"] == {}
        migration.downgrade()
        restored = sa.Table("custom_tab_entries", sa.MetaData(), autoload_with=connection)
        assert set(restored.c.keys()) == {"id", "custom_values"}
        assert (
            connection.execute(sa.select(restored.c.custom_values)).scalar_one()
            == value["custom_values"]
        )
    engine.dispose()
