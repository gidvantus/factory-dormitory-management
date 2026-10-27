"""Миграция `0047_terms_acceptance`: три колонки принятия правил в `users`.

DDL ревизии — `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...` — юнит-тестом на
SQLite не выполнить: `IF NOT EXISTS` у `ADD COLUMN` понимает PostgreSQL, а не
SQLite. Сам DDL проверяется на стенде: `alembic upgrade head`, затем
`alembic downgrade -1` и снова `alembic upgrade head`.

Зачем тогда тест. Дрейф между моделью и миграцией иначе всплывает только на
откате или на живой базе: опечатка в имени колонки даёт `UndefinedColumn` в
работе, а колонка, добавленная в `upgrade` и забытая в `downgrade`, делает
ревизию необратимой. Имена колонок здесь не переписаны — они читаются из самого
модуля ревизии и из модели, иначе опечатка прошла бы мимо проверки. Обвязчик
общий с остальными ревизиями и живёт в `tests/migration_support.py`.

Третье свойство — одна голова в дереве ревизий. Эта ревизия вставала на
сдвинувшуюся голову (`0045` → `0047`): пока PR открыт, ветка от того же узла
`0046_dashboard_per_organization` может добавить свою `0047_*`, и после мержа
`alembic upgrade head` упадёт с «Multiple head revisions». Проверка
`revision`/`down_revision` такой случай не ловит — она смотрит только на свою
строку, а не на дерево.
"""

from pathlib import Path
from types import ModuleType

from app.models.user import User
from tests.migration_support import (
    added_columns,
    assert_columns_match_model,
    assert_downgrade_removes_only_added,
    assert_nullable_without_default,
    assert_on_previous_head,
    assert_single_head,
    load_migration,
    model_columns,
    type_matches,
)

ALEMBIC_DIR = Path(__file__).resolve().parents[1] / "alembic"
MIGRATION_PATH = ALEMBIC_DIR / "versions" / "0047_terms_acceptance.py"
REVISION = "0047_terms_acceptance"
PARENT = "0046_dashboard_per_organization"
PREFIX = "terms_"


def migration() -> ModuleType:
    return load_migration(MIGRATION_PATH)


def test_migration_sits_on_top_of_the_previous_head() -> None:
    assert_on_previous_head(migration(), REVISION, PARENT)


def test_revision_tree_has_exactly_one_head() -> None:
    """Вторая голова означает `alembic upgrade head` с «Multiple head revisions»."""
    assert_single_head(ALEMBIC_DIR)


def test_it_adds_exactly_the_model_columns() -> None:
    assert_columns_match_model(migration(), User, PREFIX)


def test_types_match_the_model() -> None:
    """Тип из DDL сверяется с типом модели: момент — с часовым поясом, код — 50 символов."""
    columns = model_columns(User, PREFIX)
    for name, declared in added_columns(migration()).items():
        assert type_matches(columns[name], declared), name


def test_columns_stay_nullable_and_no_default_is_set() -> None:
    """Backfill нет: у существующих строк `NULL` = «правила не принял»."""
    assert_nullable_without_default(migration(), User, PREFIX)


def test_downgrade_removes_exactly_what_upgrade_added() -> None:
    assert_downgrade_removes_only_added(migration())
