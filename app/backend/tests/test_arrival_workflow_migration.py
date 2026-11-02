"""Миграция добавляет пустую историю, не меняя сохранённые планы и проживания."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_workflow_migration_preserves_existing_data() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0050_arrival_workflow.py"
    spec = spec_from_file_location("arrival_workflow_migration", path)
    assert spec and spec.loader
    migration: Any = module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    sa.Table("employees", metadata, sa.Column("id", sa.String(36), primary_key=True))
    residents = sa.Table(
        "residents",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("notes", sa.String()),
    )
    plans = sa.Table(
        "arrival_plans",
        metadata,
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("people", sa.JSON()),
        sa.Column("count", sa.Integer()),
    )
    original = {"id": "old-plan", "people": [{"full_name": "Сохранённое ФИО"}], "count": 12}
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(plans.insert(), original)
        connection.execute(residents.insert(), {"id": 1, "notes": "Существующий проживающий"})
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        visits = sa.Table("arrival_visits", sa.MetaData(), autoload_with=connection)
        assert connection.scalar(sa.select(sa.func.count()).select_from(visits)) == 0
        assert connection.execute(sa.select(plans)).mappings().one() == original
        assert connection.scalar(sa.select(residents.c.notes)) == "Существующий проживающий"
        migration.downgrade()
        assert connection.execute(sa.select(plans)).mappings().one() == original
    engine.dispose()
