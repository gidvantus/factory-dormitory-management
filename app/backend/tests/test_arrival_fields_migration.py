"""Добавление полей не переписывает старые ФИО, количества и ревизии."""

from datetime import date
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_additive_migration_preserves_legacy_arrivals() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0049_arrival_fields.py"
    spec = spec_from_file_location("arrival_fields_migration", path)
    assert spec and spec.loader
    migration: Any = module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    sa.Table("organizations", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    plans = sa.Table(
        "arrival_plans",
        metadata,
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("dormitory_id", sa.Integer()),
        sa.Column("date", sa.Date()),
        sa.Column("count", sa.Integer()),
        sa.Column("names", sa.JSON()),
        sa.Column("revision", sa.Integer()),
    )
    original = {
        "id": "old",
        "dormitory_id": 1,
        "date": date(2026, 10, 27),
        "count": 12,
        "names": ["Иванов Иван"],
        "revision": 7,
    }
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(plans.insert(), original)
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        current = sa.Table("arrival_plans", sa.MetaData(), autoload_with=connection)
        row = connection.execute(sa.select(current)).mappings().one()
        assert {key: row[key] for key in original} == original
        assert row["custom_values"] == {}
        assert row["people"] is None
        assert "arrival_settings" in sa.inspect(connection).get_table_names()
        migration.downgrade()
        assert connection.execute(sa.select(plans)).mappings().one() == original
    engine.dispose()
