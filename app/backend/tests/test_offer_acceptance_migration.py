"""Миграция `0048_offer_acceptance`: четыре колонки акцепта оферты в `invoices`.

DDL ревизии — `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ...` — юнит-тестом на
SQLite не выполнить: `IF NOT EXISTS` у `ADD COLUMN` понимает PostgreSQL, а не
SQLite. Внешний ключ на `users.id` — тоже свойство PostgreSQL: SQLite не умеет
добавлять `REFERENCES` к существующей таблице. Сам DDL проверяется на стенде:
`alembic upgrade head`, затем `alembic downgrade -1` и снова `alembic upgrade head`.

Зачем тогда тест. Дрейф между моделью и миграцией иначе всплывает только на
откате или на живой базе: опечатка в имени колонки даёт `UndefinedColumn` в
работе, а колонка, добавленная в `upgrade` и забытая в `downgrade`, делает
ревизию необратимой. Здесь эти свойства читаются из самого модуля ревизии —
имена колонок не переписаны в тесте, иначе опечатка прошла бы мимо проверки.

Отдельно проверяются два свойства именно этой ревизии: все колонки nullable и
без `DEFAULT` (backfill намеренно нет — «согласие задним числом» не дописывается)
и у `offer_accepted_by` есть `ON DELETE SET NULL`: удаление пользователя не
должно ни удалять счёт, ни мешать удалению.

Третье свойство — одна голова в дереве ревизий. Эта ревизия вставала на
сдвинувшуюся голову (`0045` в плане → `0048` в работе): пока PR открыт, ветка от
того же узла может добавить свою ревизию, и после мержа `alembic upgrade head`
упадёт с «Multiple head revisions». Проверка `revision`/`down_revision` такой
случай не ловит — она смотрит только на свою строку, а не на дерево.
"""

import re
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Any

import sqlalchemy as sa
from alembic.script import ScriptDirectory

from app.models.invoice import Invoice

MIGRATION_PATH = Path(__file__).resolve().parents[1] / "alembic/versions/0048_offer_acceptance.py"
REVISION = "0048_offer_acceptance"
PARENT = "0047_terms_acceptance"

ADD_PATTERN = re.compile(r"ADD COLUMN IF NOT EXISTS (\w+) (.+)$")
DROP_PATTERN = re.compile(r"DROP COLUMN IF EXISTS (\w+)$")


def load_migration() -> ModuleType:
    """Прочитать ревизию по пути, а не импортом: `alembic/versions` — не пакет."""
    spec = spec_from_file_location("offer_acceptance_migration", MIGRATION_PATH)
    assert spec and spec.loader
    migration: ModuleType = module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def normalized(statement: str) -> str:
    """Схлопнуть переносы в DDL: константа склеена из двух строк."""
    return " ".join(statement.split())


def added_columns() -> dict[str, str]:
    """Колонки `upgrade`: имя → объявленный тип (с хвостом ограничений)."""
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
        name: column
        for name, column in Invoice.__table__.columns.items()
        if name.startswith("offer_")
    }


def test_migration_sits_on_top_of_the_previous_head() -> None:
    migration = load_migration()

    assert migration.revision == REVISION
    assert migration.down_revision == PARENT


def test_revision_tree_has_exactly_one_head() -> None:
    """Вторая голова означает `alembic upgrade head` с «Multiple head revisions»."""
    scripts = ScriptDirectory(str(Path(__file__).resolve().parents[1] / "alembic"))
    assert len(scripts.get_heads()) == 1


def test_it_adds_exactly_the_model_columns() -> None:
    """Множества имён совпадают: колонка модели без DDL — `UndefinedColumn` в работе."""
    assert set(added_columns()) == set(model_columns())


def test_types_match_the_model() -> None:
    """Тип из DDL сверяется с типом модели: момент — с часовым поясом, код — 50 символов."""
    columns = model_columns()
    for name, declared in added_columns().items():
        column = columns[name]
        if isinstance(column.type, sa.String):
            assert declared.upper().startswith(f"VARCHAR({column.type.length})"), name
        elif isinstance(column.type, sa.DateTime):
            assert column.type.timezone is True, name
            assert declared.upper().startswith("TIMESTAMP WITH TIME ZONE"), name
        else:
            # Автор акцепта — целое со ссылкой на `users.id`.
            assert isinstance(column.type, sa.Integer), name
            assert declared.upper().startswith("INTEGER"), name


def test_the_accept_author_references_users_with_set_null() -> None:
    """Удаление пользователя не должно ни удалять счёт, ни мешать удалению."""
    declared = added_columns()["offer_accepted_by"].upper()

    assert "REFERENCES USERS(ID)" in declared
    assert "ON DELETE SET NULL" in declared

    foreign_keys = model_columns()["offer_accepted_by"].foreign_keys
    assert [fk.target_fullname for fk in foreign_keys] == ["users.id"]
    assert next(iter(foreign_keys)).ondelete is not None
    assert str(next(iter(foreign_keys)).ondelete).upper() == "SET NULL"


def test_columns_stay_nullable_and_no_default_is_set() -> None:
    """Backfill нет: у старых счетов `NULL` = «акцепта нет», и это намеренно."""
    for name, column in model_columns().items():
        assert column.nullable is True, name
    for statement in load_migration().ADD_COLUMNS_SQL:
        sql = normalized(statement).upper()
        assert "NOT NULL" not in sql
        assert "DEFAULT" not in sql


def test_downgrade_removes_exactly_what_upgrade_added() -> None:
    """Забытая в `downgrade` колонка делает ревизию необратимой."""
    assert sorted(dropped_columns()) == sorted(added_columns())
