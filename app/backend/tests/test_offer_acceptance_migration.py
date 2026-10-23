"""Миграция `0048_offer_acceptance`: четыре колонки акцепта оферты в `invoices`.

DDL ревизии — `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ...` — юнит-тестом на
SQLite не выполнить: `IF NOT EXISTS` у `ADD COLUMN` понимает PostgreSQL, а не
SQLite. Внешний ключ на `users.id` — тоже свойство PostgreSQL: SQLite не умеет
добавлять `REFERENCES` к существующей таблице. Сам DDL проверяется на стенде:
`alembic upgrade head`, затем `alembic downgrade -1` и снова `alembic upgrade head`.

Зачем тогда тест. Дрейф между моделью и миграцией иначе всплывает только на
откате или на живой базе: опечатка в имени колонки даёт `UndefinedColumn` в
работе, а колонка, добавленная в `upgrade` и забытая в `downgrade`, делает
ревизию необратимой. Имена колонок здесь не переписаны — они читаются из самого
модуля ревизии и из модели, иначе опечатка прошла бы мимо проверки. Обвязчик
общий с остальными ревизиями и живёт в `tests/migration_support.py`.

Своё у этой ревизии — три вещи. Колонки nullable и без `DEFAULT`: backfill
намеренно нет, «согласие задним числом» не дописывается. У `offer_accepted_by`
есть `ON DELETE SET NULL`: удаление пользователя не должно ни удалять счёт, ни
мешать удалению. И одна голова в дереве: ревизия вставала на сдвинувшуюся голову
(`0045` в плане → `0048` в работе), а проверка `revision`/`down_revision` такой
случай не ловит — она смотрит только на свою строку, а не на дерево.
"""

from pathlib import Path
from types import ModuleType

from app.models.invoice import Invoice
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
MIGRATION_PATH = ALEMBIC_DIR / "versions" / "0048_offer_acceptance.py"
REVISION = "0048_offer_acceptance"
PARENT = "0047_terms_acceptance"
PREFIX = "offer_"


def migration() -> ModuleType:
    return load_migration(MIGRATION_PATH)


def test_migration_sits_on_top_of_the_previous_head() -> None:
    assert_on_previous_head(migration(), REVISION, PARENT)


def test_revision_tree_has_exactly_one_head() -> None:
    assert_single_head(ALEMBIC_DIR)


def test_it_adds_exactly_the_model_columns() -> None:
    assert_columns_match_model(migration(), Invoice, PREFIX)


def test_types_match_the_model() -> None:
    """Тип из DDL сверяется с типом модели: момент — с поясом, код — 50, автор — `INTEGER`."""
    columns = model_columns(Invoice, PREFIX)
    for name, declared in added_columns(migration()).items():
        assert type_matches(columns[name], declared), name


def test_the_accept_author_references_users_with_set_null() -> None:
    """Удаление пользователя не должно ни удалять счёт, ни мешать удалению."""
    declared = added_columns(migration())["offer_accepted_by"].upper()

    assert "REFERENCES USERS(ID)" in declared
    assert "ON DELETE SET NULL" in declared

    foreign_keys = model_columns(Invoice, PREFIX)["offer_accepted_by"].foreign_keys
    assert [fk.target_fullname for fk in foreign_keys] == ["users.id"]
    target = next(iter(foreign_keys))
    assert target.ondelete is not None
    assert str(target.ondelete).upper() == "SET NULL"


def test_columns_stay_nullable_and_no_default_is_set() -> None:
    assert_nullable_without_default(migration(), Invoice, PREFIX)


def test_downgrade_removes_exactly_what_upgrade_added() -> None:
    assert_downgrade_removes_only_added(migration())
