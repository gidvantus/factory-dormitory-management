"""Удаление решений не меняет проживание, связи и ранее записанные события."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_remove_decisions_keeps_dates_history_and_other_preferences() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0041_remove_shift_decisions.py"
    spec = spec_from_file_location("remove_shift_decisions", path)
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
    plans = sa.Table(
        "employee_plans",
        metadata,
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("kind", sa.String()),
    )
    decisions = sa.Table(
        "employee_decisions",
        metadata,
        sa.Column("resident_id", sa.Integer(), primary_key=True),
        sa.Column("plan_id", sa.String()),
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
            "residents",
            "employee_events",
            "employee_notes",
            "arrival_plans",
            "personnel_bindings",
        )
    ]
    kept = {
        "id": "current",
        "column_filters": [
            {"field": "residence_status", "operator": "equals", "value": "Проживает"}
        ],
    }
    removed = {
        "id": "decisions",
        "column_filters": [
            {"field": "shift_decision", "operator": "equals", "value": "Продление согласовано"}
        ],
    }
    blocks = [
        {"id": "ending", "kind": "ending"},
        {"id": "good", "kind": "saved", "saved_list_id": "current"},
    ]
    clean = {"lists": [kept], "blocks": blocks, "future": True}
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        metadata.create_all(connection)
        migration.__dict__["op"] = Operations(MigrationContext.configure(connection))
        connection.execute(
            plans.insert(),
            [
                {"id": "decision-departure", "kind": "departure"},
                {"id": "manual-departure", "kind": "departure"},
                {"id": "arrival", "kind": "arrival"},
            ],
        )
        connection.execute(
            decisions.insert(),
            [
                {"resident_id": 1, "plan_id": "decision-departure"},
                {"resident_id": 2, "plan_id": None},
            ],
        )
        connection.execute(
            preferences.insert(),
            [
                {
                    "user_id": 1,
                    "revision": 7,
                    "settings": {
                        **clean,
                        "lists": [kept, removed],
                        "blocks": [
                            *blocks,
                            {"id": "old", "kind": "saved", "saved_list_id": "decisions"},
                        ],
                    },
                },
                {"user_id": 2, "revision": 7, "settings": clean},
            ],
        )
        snapshot = {
            "employee_id": "person",
            "shift_end": "2026-10-25",
            "comment": "Продление согласовано",
        }
        for table in records:
            connection.execute(table.insert().values(id="kept", data=snapshot))
        migration.upgrade()
        assert "employee_decisions" not in sa.inspect(connection).get_table_names()
        assert set(connection.scalars(sa.select(plans.c.id))) == {"manual-departure", "arrival"}
        rows = list(
            connection.execute(sa.select(preferences).order_by(preferences.c.user_id)).mappings()
        )
        assert [row["settings"] for row in rows] == [clean, clean]
        assert [row["revision"] for row in rows] == [8, 7]
        for table in records:
            assert connection.scalar(sa.select(table.c.data)) == snapshot
        migration.downgrade()
        assert "employee_decisions" in sa.inspect(connection).get_table_names()
