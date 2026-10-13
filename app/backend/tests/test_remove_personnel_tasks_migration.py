"""Удаление задач сохраняет остальные данные и пользовательские настройки."""

from datetime import date
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_migration_removes_only_tasks_and_their_blocks() -> None:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0031_remove_personnel_tasks.py"
    spec = spec_from_file_location("remove_personnel_tasks", path)
    assert spec and spec.loader
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    metadata = sa.MetaData()
    sa.Table("users", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    sa.Table("employees", metadata, sa.Column("id", sa.String(36), primary_key=True))
    events = sa.Table(
        "employee_events",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String()),
        sa.Column("snapshot", sa.JSON()),
    )
    preferences = sa.Table(
        "personnel_preferences",
        metadata,
        sa.Column("user_id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer()),
        sa.Column("settings", sa.JSON()),
    )
    notes = sa.Table("employee_notes", metadata, sa.Column("id", sa.String(), primary_key=True))
    plans = sa.Table("employee_plans", metadata, sa.Column("id", sa.String(), primary_key=True))
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        metadata.create_all(connection)
        migration.op = Operations(MigrationContext.configure(connection))
        migration.downgrade()  # Создаём прежнюю таблицу задач для проверки перехода.
        tasks = sa.Table("employee_tasks", sa.MetaData(), autoload_with=connection)
        connection.execute(
            tasks.insert().values(
                id="task",
                employee_id="person",
                text="Позвонить",
                due=date(2026, 10, 13),
                done=False,
            )
        )
        connection.execute(
            events.insert(),
            [
                {"id": 1, "kind": "task", "snapshot": {}},
                {"id": 2, "kind": "note", "snapshot": {"text": "Важная заметка"}},
                {"id": 3, "kind": "shift", "snapshot": {"start": "2026-10-13"}},
            ],
        )
        connection.execute(notes.insert().values(id="note"))
        connection.execute(plans.insert().values(id="plan"))
        resident = {"id": "resident", "kind": "residents", "title": "Мой блок", "scope": [2]}
        contacts = {"id": "contacts", "kind": "contacts"}
        task = {"id": "task-block", "kind": "tasks"}
        other = {"lists": [{"id": "saved"}], "favorites": ["person"], "future_setting": True}
        settings = [
            {**other, "blocks": [resident, task, contacts]},
            {**other, "blocks": [task]},
            {**other, "blocks": None},
            {**other, "blocks": []},
        ]
        connection.execute(
            preferences.insert(),
            [
                {"user_id": index, "revision": 7, "settings": value}
                for index, value in enumerate(settings, 1)
            ],
        )
        migration.upgrade()
        assert "employee_tasks" not in sa.inspect(connection).get_table_names()
        assert list(connection.scalars(sa.select(events.c.kind).order_by(events.c.id))) == [
            "note",
            "shift",
        ]
        assert connection.scalar(sa.select(notes.c.id)) == "note"
        assert connection.scalar(sa.select(plans.c.id)) == "plan"
        rows = list(
            connection.execute(sa.select(preferences).order_by(preferences.c.user_id)).mappings()
        )
        assert rows[0]["settings"] == {**other, "blocks": [resident, contacts]}
        assert rows[1]["settings"] == {**other, "blocks": []}
        assert [row["revision"] for row in rows] == [8, 8, 7, 7]
        assert rows[2]["settings"] == settings[2]
        assert rows[3]["settings"] == settings[3]
        migration.downgrade()
        assert connection.scalar(sa.select(sa.func.count()).select_from(tasks)) == 0
        assert (
            sa.inspect(connection).get_indexes("employee_tasks")[0]["name"]
            == "ix_employee_tasks_employee_id"
        )
        migration.upgrade()
        assert list(
            connection.scalars(sa.select(preferences.c.revision).order_by(preferences.c.user_id))
        ) == [8, 8, 7, 7]
    engine.dispose()
