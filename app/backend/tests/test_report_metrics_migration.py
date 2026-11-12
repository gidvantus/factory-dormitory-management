"""Старые отчёты и раскладки сохраняются при добавлении постоянных связей."""

import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_existing_report_rows_and_templates_keep_their_values() -> None:
    path = Path(__file__).parents[1] / "alembic/versions/0071_report_metrics_and_blocks.py"
    spec = importlib.util.spec_from_file_location("report_metric_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = sa.create_engine("sqlite:///:memory:")
    with engine.begin() as db, Operations.context(MigrationContext.configure(db)):
        db.exec_driver_sql(
            "CREATE TABLE report_rows (id int, dormitory_id int, name text, formula text)"
        )
        db.exec_driver_sql("CREATE TABLE report_template_rows (id int, name text, formula text)")
        db.exec_driver_sql("CREATE TABLE dashboard_layout (id int, revision int)")
        db.exec_driver_sql(
            "INSERT INTO report_rows VALUES (7, 1, 'Выход Итого', '=3'), "
            "(8, 1, 'Другой показатель', '=5')"
        )
        db.exec_driver_sql("INSERT INTO report_template_rows VALUES (5, 'проживает итого', '=2')")
        db.exec_driver_sql("INSERT INTO dashboard_layout VALUES (1, 12)")
        migration.upgrade()
        assert db.exec_driver_sql(
            "SELECT id, name, formula, metric_key FROM report_rows ORDER BY id"
        ).all() == [(7, "Выход Итого", "=3", "attendance"), (8, "Другой показатель", "=5", None)]
        assert db.exec_driver_sql(
            "SELECT name, formula, metric_key FROM report_template_rows"
        ).one() == ("проживает итого", "=2", "residents")
        assert db.exec_driver_sql(
            "SELECT revision, builtin_settings FROM dashboard_layout"
        ).one() == (12, "{}")
        migration.downgrade()
        assert db.exec_driver_sql("SELECT count(*) FROM report_rows").scalar_one() == 2
    engine.dispose()
