"""Ревизия `0067_company_details`: таблица реквизитов и засев единственной строки.

Проверяется то, чего не видно в тестах ручек:

* родитель ревизии и одна голова дерева: `alembic upgrade head` обязан остаться
  работоспособным;
* набор колонок совпадает с моделью `CompanyDetails` — колонка модели без DDL
  падала бы в работе;
* имя и условие `CHECK` совпадают с моделью: `ck_company_details_single_row` и
  `id = 1`;
* засев даёт **ровно одну** строку: `id = 1`, все реквизиты `NULL`,
  `vat_note = 'НДС не облагается'`;
* повторный прогон засева (обрыв миграции) строку не задваивает и не падает;
* откат снимает таблицу целиком.

DDL `op.create_table` на SQLite прогоняется настоящим `op`; `CHECK (id = 1)` на
SQLite работает так же, как на PostgreSQL, поэтому запрет второй строки
проверяется здесь же. Общий прогон `alembic upgrade head` → `downgrade -1` →
`upgrade head` делается на стенде: там настоящая PostgreSQL.
"""

from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import cast

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.exc import IntegrityError

from app.models.base import Base
from app.models.company_details import (
    SINGLE_ROW_CHECK_NAME,
    SINGLE_ROW_CONDITION_SQL,
    SINGLE_ROW_ID,
    CompanyDetails,
)
from tests.migration_support import (
    assert_on_previous_head,
    assert_single_head,
    load_migration,
    with_operations,
)

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic/versions"
ALEMBIC_DIR = BACKEND / "alembic"

REVISION = "0067_company_details"
PARENT = "0066_invoice_items"
TABLE_NAME = "company_details"


def migration() -> ModuleType:
    return load_migration(VERSIONS / f"{REVISION}.py")


@pytest.fixture
def connection() -> Iterator[sa.Connection]:
    """Схема из моделей без таблицы реквизитов и с настоящим `op` внутри ревизии.

    `company_details` снимается до ревизии: `Base.metadata.create_all` создал бы
    её из модели, и `op.create_table` упал бы на существующей таблице. Тест
    проверяет именно DDL миграции, поэтому таблицу строит она.
    """
    engine = sa.create_engine("sqlite://")
    try:
        Base.metadata.create_all(engine)
        company_table().drop(engine)
        with engine.begin() as conn:
            yield conn
    finally:
        engine.dispose()


def with_revision(connection: sa.Connection) -> ModuleType:
    return with_operations(migration(), Operations(MigrationContext.configure(connection)))


def company_table() -> sa.Table:
    """Таблица `company_details` как `Table`: `__table__` у модели типизирован шире."""
    return cast(sa.Table, CompanyDetails.__table__)


def rows(connection: sa.Connection) -> list[dict[str, object]]:
    """Строки таблицы после `upgrade`: в тестах она всегда одна."""
    table = sa.Table(TABLE_NAME, sa.MetaData(), autoload_with=connection)
    return [dict(row) for row in connection.execute(sa.select(table)).mappings()]


def test_revision_stands_on_the_expected_parent() -> None:
    """Родитель — голова `origin/develop-m` на момент постановки, а не номер из задачи."""
    assert_on_previous_head(migration(), REVISION, PARENT)


def test_the_revision_tree_has_exactly_one_head() -> None:
    assert_single_head(ALEMBIC_DIR)


def test_columns_match_the_model(connection: sa.Connection) -> None:
    """Колонка модели без DDL — `UndefinedColumn` в работе, лишняя — мусор."""
    with_revision(connection).upgrade()

    reflected = sa.Table(TABLE_NAME, sa.MetaData(), autoload_with=connection)
    declared = company_table()
    assert set(reflected.columns.keys()) == set(declared.columns.keys())
    for name, column in declared.columns.items():
        assert reflected.columns[name].nullable == column.nullable, name
        assert str(reflected.columns[name].type).upper() == str(column.type).upper(), name


def test_columns_cover_the_model_columns_of_the_table() -> None:
    """Модель объявляет ровно тот набор колонок, который перечисляет миграция."""
    assert set(CompanyDetails.__table__.columns.keys()) == {
        "id",
        "name",
        "inn",
        "kpp",
        "ogrn",
        "address",
        "bank_name",
        "bank_bic",
        "bank_account",
        "corr_account",
        "signatory",
        "vat_note",
        "updated_at",
    }


def test_constraint_name_and_condition_match_the_model(connection: sa.Connection) -> None:
    """Имя и условие `CHECK` — те же, что объявляет модель."""
    module = with_revision(connection)
    module.upgrade()

    checks = {
        str(constraint.name): " ".join(str(constraint.sqltext).split())
        for constraint in company_table().constraints
        if isinstance(constraint, sa.CheckConstraint)
    }

    assert set(checks) == {SINGLE_ROW_CHECK_NAME}
    assert checks[SINGLE_ROW_CHECK_NAME] == SINGLE_ROW_CONDITION_SQL
    # Условие и имя в ревизии записаны теми же константами, что в модели.
    assert module.SINGLE_ROW_CHECK == SINGLE_ROW_CHECK_NAME
    assert module.SINGLE_ROW_CONDITION_SQL == SINGLE_ROW_CONDITION_SQL


def test_upgrade_seeds_exactly_one_row(connection: sa.Connection) -> None:
    """Одна строка с пустыми реквизитами и заполненной строкой про НДС."""
    module = with_revision(connection)
    module.upgrade()

    seeded = rows(connection)

    assert len(seeded) == 1
    row = seeded[0]
    assert row["id"] == SINGLE_ROW_ID
    # Реквизитов пока нет: печатная форма печатает заглушку, а не выдуманные данные.
    for name in (
        "name",
        "inn",
        "kpp",
        "ogrn",
        "address",
        "bank_name",
        "bank_bic",
        "bank_account",
        "corr_account",
        "signatory",
    ):
        assert row[name] is None, name
    assert row["vat_note"] == module.DEFAULT_VAT_NOTE == "НДС не облагается"
    assert row["updated_at"] is not None


def test_the_seed_is_idempotent(connection: sa.Connection) -> None:
    """Повторный прогон засева (обрыв миграции) не задваивает строку."""
    module = with_revision(connection)
    module.upgrade()

    connection.execute(module.SEED_SQL)

    assert [row["id"] for row in rows(connection)] == [SINGLE_ROW_ID]


def test_a_second_row_is_rejected(connection: sa.Connection) -> None:
    """`CHECK (id = 1)` держит «строка одна» в базе, а не в голове автора ручки."""
    with_revision(connection).upgrade()
    table = sa.Table(TABLE_NAME, sa.MetaData(), autoload_with=connection)

    with pytest.raises(IntegrityError):
        connection.execute(sa.insert(table).values(id=2, vat_note="вторая строка"))


def test_downgrade_removes_the_table(connection: sa.Connection) -> None:
    """Откат снимает таблицу целиком — вместе с единственной строкой."""
    revision = with_revision(connection)
    revision.upgrade()

    revision.downgrade()

    assert not sa.inspect(connection).has_table(TABLE_NAME)
