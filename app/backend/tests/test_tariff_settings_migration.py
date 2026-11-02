"""Ревизия `0050_tariff_settings`: настройки яруса и квартальный период.

Проверяется то, чего не видно в юнит-тестах моделей: набор колонок совпадает с
моделью (колонка модели без DDL — `UndefinedColumn` в работе), колонки nullable и
без `DEFAULT` (backfill им не нужен), откат снимает ровно добавленное, а `CHECK`
периодов расширяется сразу в двух таблицах — у тарифов и у решений магазина —
и включает квартал, не теряя полгода.

DDL этой ревизии на SQLite не прогоняется: `ADD COLUMN IF NOT EXISTS` и
добавление `CHECK` к существующей таблице понимает PostgreSQL. Это проверяется на
стенде (`alembic upgrade head`, `downgrade -1`), как и у остальных ревизий с DDL.
"""

from pathlib import Path
from types import ModuleType

from app.models.solution import SOLUTION_PERIODS, SOLUTION_PERIODS_SQL
from app.models.tariff import TARIFF_PERIODS, Tariff
from tests.migration_support import (
    added_columns,
    assert_downgrade_removes_only_added,
    assert_on_previous_head,
    assert_single_head,
    column_type_sql,
    dropped_columns,
    load_migration,
    normalized,
)

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic/versions"
ALEMBIC_DIR = BACKEND / "alembic"

REVISION = "0050_tariff_settings"
# Родитель — ревизия соседнего PR #102, а не `0049`: две ветки ставили свои первые
# ревизии на один и тот же `0049`, и это давало в alembic две головы. Вторая по
# слиянию ветка ставит своей головой голову первой, поэтому и тест ждёт её.
PARENT = "0050_public_document_texts"

# Колонки яруса, которые заводит ревизия.
NEW_COLUMNS = ("max_members", "tooltip", "group_code")


def migration() -> ModuleType:
    return load_migration(VERSIONS / f"{REVISION}.py")


def test_revision_stands_on_the_single_current_head() -> None:
    assert_on_previous_head(migration(), REVISION, PARENT)
    assert_single_head(ALEMBIC_DIR)


def test_added_columns_match_the_model() -> None:
    module = migration()
    parsed = added_columns(module)

    assert set(parsed) == set(NEW_COLUMNS)
    for name, declared in parsed.items():
        column = Tariff.__table__.columns[name]
        assert declared.upper().startswith(column_type_sql(column)), name


def test_added_columns_are_nullable_without_a_default() -> None:
    module = migration()

    for name in NEW_COLUMNS:
        assert Tariff.__table__.columns[name].nullable is True, name
    for statement in module.ADD_COLUMNS_SQL:
        sql = normalized(statement).upper()
        assert "NOT NULL" not in sql, statement
        assert "DEFAULT" not in sql, statement


def test_downgrade_removes_only_the_added_columns() -> None:
    module = migration()

    assert_downgrade_removes_only_added(module)
    assert set(dropped_columns(module)) == set(NEW_COLUMNS)


def test_period_check_is_extended_in_both_tables() -> None:
    """Набор периодов общий с решениями, поэтому `CHECK` меняется в двух таблицах."""
    module = migration()

    tables = {table for table, _constraint in module.PERIOD_CHECKS}
    assert tables == {"tariffs", "solutions"}

    new_values = module.NEW_PERIODS_SQL
    old_values = module.OLD_PERIODS_SQL
    for period in TARIFF_PERIODS:
        assert f"'{period}'" in new_values, period
    assert "'quarter'" in new_values
    assert "'quarter'" not in old_values
    # Полугодовой период не теряется: на нём стоит уже проданный «Стандарт».
    assert "'half_year'" in new_values


def test_model_periods_include_the_quarter() -> None:
    """Квартал есть и в модели тарифов, и в модели решений: константа у них одна."""
    assert "quarter" in TARIFF_PERIODS
    # Полугодовой период не теряется: на нём стоит уже проданный «Стандарт».
    assert "half_year" in TARIFF_PERIODS
    assert SOLUTION_PERIODS == TARIFF_PERIODS
    assert "quarter" in SOLUTION_PERIODS_SQL
