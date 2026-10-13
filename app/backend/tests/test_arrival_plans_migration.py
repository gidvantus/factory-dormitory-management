"""Переход к дневным количествам сохраняет старые планы и настройки."""

from datetime import date
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_migrates_individual_arrivals_and_preserves_other_data() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0032_arrival_plans.py"
    spec = spec_from_file_location("arrival_plans_migration", path)
    assert spec and spec.loader
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    metadata = sa.MetaData()
    dormitories = sa.Table("dormitories", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    employees = sa.Table(
        "employees",
        metadata,
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("full_name", sa.String()),
    )
    plans = sa.Table(
        "employee_plans",
        metadata,
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("employee_id", sa.String()),
        sa.Column("dormitory_id", sa.Integer()),
        sa.Column("date", sa.Date()),
        sa.Column("kind", sa.String()),
    )
    preferences = sa.Table(
        "personnel_preferences",
        metadata,
        sa.Column("user_id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer()),
        sa.Column("settings", sa.JSON()),
    )
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(dormitories.insert(), [{"id": 1}, {"id": 2}])
        connection.execute(
            employees.insert(),
            [{"id": "a", "full_name": "Иванов Иван"}, {"id": "b", "full_name": None}],
        )
        originals = [
            {
                "id": "1",
                "employee_id": "a",
                "dormitory_id": 1,
                "date": date(2026, 10, 20),
                "kind": "arrival",
            },
            {
                "id": "2",
                "employee_id": "b",
                "dormitory_id": 1,
                "date": date(2026, 10, 20),
                "kind": "arrival",
            },
            {
                "id": "3",
                "employee_id": "a",
                "dormitory_id": 2,
                "date": date(2026, 10, 20),
                "kind": "arrival",
            },
            {
                "id": "4",
                "employee_id": "a",
                "dormitory_id": 1,
                "date": date(2026, 10, 21),
                "kind": "departure",
            },
        ]
        connection.execute(plans.insert(), originals)
        settings = {
            "blocks": [
                {"id": "p", "kind": "plans", "title": "План заездов и выездов"},
                {"kind": "residents", "title": "Мой блок"},
            ],
            "lists": [{"filter": "arrivals", "name": "Заезды"}, {"filter": "current"}],
            "favorites": ["a"],
            "other": True,
        }
        connection.execute(
            preferences.insert(),
            [
                {"user_id": 1, "revision": 4, "settings": settings},
                {"user_id": 2, "revision": 3, "settings": {"blocks": None, "lists": []}},
            ],
        )
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        arrivals = sa.Table("arrival_plans", sa.MetaData(), autoload_with=connection)
        rows = list(
            connection.execute(sa.select(arrivals).order_by(arrivals.c.dormitory_id)).mappings()
        )
        assert [(row["dormitory_id"], row["count"], row["names"]) for row in rows] == [
            (1, 2, ["Иванов Иван"]),
            (2, 1, ["Иванов Иван"]),
        ]
        assert all(row["date"] == date(2026, 10, 20) for row in rows)
        assert (
            list(connection.execute(sa.select(plans).order_by(plans.c.id)).mappings()) == originals
        )
        changed = (
            connection.execute(sa.select(preferences).where(preferences.c.user_id == 1))
            .mappings()
            .one()
        )
        assert changed["revision"] == 5
        assert changed["settings"]["favorites"] == ["a"]
        assert changed["settings"]["blocks"][0]["title"] == "План заездов"
        assert changed["settings"]["lists"][0]["filter"] == "all"
        assert changed["settings"]["blocks"][1] == settings["blocks"][1]
        assert (
            connection.scalar(sa.select(preferences.c.revision).where(preferences.c.user_id == 2))
            == 3
        )
        migration.downgrade()
        assert "arrival_plans" not in sa.inspect(connection).get_table_names()
        assert connection.scalar(sa.select(sa.func.count()).select_from(plans)) == 4
    engine.dispose()
