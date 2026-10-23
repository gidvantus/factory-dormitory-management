"""Миграция `0047_terms_acceptance`: три колонки принятия правил в `users`.

DDL ревизии — `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...` — юнит-тестом на
SQLite не выполнить: `IF NOT EXISTS` у `ADD COLUMN` понимает PostgreSQL, а не
SQLite. Сам DDL проверяется на стенде: `alembic upgrade head`, затем
`alembic downgrade -1` и снова `alembic upgrade head`.

Зачем тогда тест. Дрейф между моделью и миграцией иначе всплывает только на
откате или на живой базе: опечатка в имени колонки даёт `UndefinedColumn` в
работе, а колонка, добавленная в `upgrade` и забытая в `downgrade`, делает
ревизию необратимой. Здесь эти два свойства читаются из самого модуля ревизии —
имена колонок не переписаны в тесте, иначе опечатка прошла бы мимо проверки.
"""

import re
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Any

import sqlalchemy as sa

from app.models.user import User

MIGRATION_PATH = Path(__file__).resolve().parents[1] / "alembic/versions/0047_terms_acceptance.py"
REVISION = "0047_terms_acceptance"
PARENT = "0046_dashboard_per_organization"

ADD_PATTERN = re.compile(r"ADD COLUMN IF NOT EXISTS (\w+) (.+)$")
DROP_PATTERN = re.compile(r"DROP COLUMN IF EXISTS (\w+)$")


def load_migration() -> ModuleType:
    """Прочитать ревизию по пути, а не импортом: `alembic/versions` — не пакет."""
    spec = spec_from_file_location("terms_acceptance_migration", MIGRATION_PATH)
    assert spec and spec.loader
    migration: ModuleType = module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def normalized(statement: str) -> str:
    """Схлопнуть переносы в DDL: константа склеена из двух строк."""
    return " ".join(statement.split())


def added_columns() -> dict[str, str]:
    """Колонки `upgrade`: имя → объявленный тип."""
    parsed: dict[str, str] = {}
    for statement in load_migration().ADD_COLUMNS_SQL:
        match = ADD_PATTERN.search(normalized(statement))
        assert match is not None, statement
        parsed[match.group(1)] = match.group(2)
    return parsed


def dropped_columns() -> list[str]:
    """Колонки `downgrade` в том порядке, в котором их снимают."""
    names: list[str] = []
    for statement in load_migration().DROP_COLUMNS_SQL:
        match = DROP_PATTERN.search(normalized(statement))
        assert match is not None, statement
        names.append(match.group(1))
    return names


def model_columns() -> dict[str, Any]:
    """Колонки модели, которые заводит эта ревизия."""
    return {
        name: column for name, column in User.__table__.columns.items() if name.startswith("terms_")
    }


def test_migration_sits_on_top_of_the_previous_head() -> None:
    migration = load_migration()

    assert migration.revision == REVISION
    assert migration.down_revision == PARENT


def test_it_adds_exactly_the_model_columns() -> None:
    """Множества имён совпадают: колонка модели без DDL — `UndefinedColumn` в работе."""
    assert set(added_columns()) == set(model_columns())


def test_types_match_the_model() -> None:
    """Тип из DDL сверяется с типом модели: момент — с часовым поясом, код — 50 символов."""
    columns = model_columns()
    for name, declared in added_columns().items():
        column = columns[name]
        if isinstance(column.type, sa.String):
            assert declared.upper() == f"VARCHAR({column.type.length})", name
        else:
            assert isinstance(column.type, sa.DateTime)
            assert column.type.timezone is True, name
            assert declared.upper() == "TIMESTAMP WITH TIME ZONE", name


def test_columns_stay_nullable_and_no_default_is_set() -> None:
    """Backfill нет: у существующих строк `NULL` = «правила не принял»."""
    for name, column in model_columns().items():
        assert column.nullable is True, name
    for statement in load_migration().ADD_COLUMNS_SQL:
        sql = normalized(statement).upper()
        assert "NOT NULL" not in sql
        assert "DEFAULT" not in sql


def test_downgrade_removes_exactly_what_upgrade_added() -> None:
    """Забытая в `downgrade` колонка делает ревизию необратимой."""
    assert sorted(dropped_columns()) == sorted(added_columns())
