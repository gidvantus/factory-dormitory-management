"""Ревизии `0063_merge_stand_heads` и `0064_extra_seats` (#168).

Проверяется то, чего не видно в юнит-тестах моделей:

* набор колонок совпадает с моделями (`extra_seats` в `organizations`,
  `quantity` в `invoices`) — колонка модели без DDL падала бы в работе;
* откат снимает ровно добавленное;
* `CHECK` на вид предмета счёта расширен третьим видом `seats` и совпадает с
  набором, который объявляет модель, а прежний набор `downgrade` не теряет
  `tariff` и `solution`;
* `CHECK` на количество мест имеет то же имя и то же условие, что в модели:
  `NULL` («не про количество») допустим, ноль и минус — нет;
* seed-строка каталога «Дополнительные сотрудники» вставляется идемпотентно:
  повторный прогон шага не падает на `UNIQUE(name)` и второй строки не плодит;
* дерево ревизий — одна голова. До этой ветки голов было две
  (`0060_merge_stand_heads` и основная ветка), поэтому сводящая ревизия
  `0063_merge_stand_heads` проверяется здесь же: именно она возвращает
  `alembic upgrade head` работоспособность. Стоит она **до** ревизии мест
  намеренно: голова дерева остаётся обычной ревизией с одним родителем, и только
  так `alembic downgrade -1` на стенде не упирается в `Ambiguous walk`.

DDL этой ревизии на SQLite целиком не прогоняется: `ALTER TABLE … DROP
CONSTRAINT` понимает PostgreSQL, а не SQLite. Это проверяется на стенде
(`alembic upgrade head`, `downgrade -1`, снова `upgrade head`), как и у
остальных ревизий с DDL; seed-запрос здесь исполняется по-настоящему.
"""

from pathlib import Path
from types import ModuleType
from typing import cast

import sqlalchemy as sa

from app.models.base import Base
from app.models.invoice import INVOICE_ITEM_KINDS, Invoice
from app.models.organization import Organization
from app.models.solution import Solution
from tests.migration_support import (
    added_columns,
    assert_downgrade_removes_only_added,
    assert_on_previous_head,
    assert_single_head,
    column_type_sql,
    dropped_columns,
    load_migration,
)

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic/versions"
ALEMBIC_DIR = BACKEND / "alembic"

REVISION = "0064_extra_seats"
PARENT = "0063_merge_stand_heads"

MERGE_REVISION = "0063_merge_stand_heads"
# Головы, которые сводит `0063`: ветка стенда и основная ветка.
MERGED_HEADS = ("0060_merge_stand_heads", "0062_table_views")

# Колонки ревизии и модели, в которой они должны быть объявлены.
COLUMNS = {"extra_seats": Organization, "quantity": Invoice}

# Seed-строка каталога магазина улучшений.
SEED_CODE = "extra_member"
SEED_NAME = "Дополнительные сотрудники"
SEED_AMOUNT = "900.00"
SEED_PERIOD = "once"
SEED_POSITION = 900


def migration() -> ModuleType:
    return load_migration(VERSIONS / f"{REVISION}.py")


def merge_migration() -> ModuleType:
    return load_migration(VERSIONS / f"{MERGE_REVISION}.py")


def test_revision_stands_on_the_expected_parent() -> None:
    """Родитель — текущая голова `develop-m`, а не номер из постановки."""
    assert_on_previous_head(migration(), REVISION, PARENT)


def test_merge_revision_joins_the_two_heads() -> None:
    """Слияние сводит ветку стенда с основной веткой и ничего не меняет в схеме."""
    module = merge_migration()

    assert module.revision == MERGE_REVISION
    assert module.down_revision == MERGED_HEADS
    assert module.upgrade() is None
    assert module.downgrade() is None


def test_the_revision_tree_has_exactly_one_head() -> None:
    assert_single_head(ALEMBIC_DIR)


def test_added_columns_match_the_models() -> None:
    parsed = added_columns(migration())

    assert set(parsed) == set(COLUMNS)
    for name, declared in parsed.items():
        column = COLUMNS[name].__table__.columns[name]
        assert declared.upper().startswith(column_type_sql(column)), name


def test_extra_seats_is_not_nullable_with_a_zero_default() -> None:
    """`NOT NULL DEFAULT 0`: у существующих организаций мест не докуплено — это ноль."""
    statement = migration().ADD_COLUMNS_SQL[0].upper()

    assert Organization.__table__.columns["extra_seats"].nullable is False
    assert "NOT NULL" in statement
    assert "DEFAULT 0" in statement


def test_quantity_stays_nullable_without_a_default() -> None:
    """`NULL` у исторических счетов и счетов за тариф — «не про количество»."""
    column = Invoice.__table__.columns["quantity"]
    quantity_statement = migration().ADD_COLUMNS_SQL[1].upper()

    assert column.nullable is True
    assert "NOT NULL" not in quantity_statement
    assert "DEFAULT" not in quantity_statement


def test_downgrade_removes_only_the_added_columns() -> None:
    module = migration()

    assert_downgrade_removes_only_added(module)
    assert set(dropped_columns(module)) == set(COLUMNS)


def test_the_item_kind_check_gains_the_seats_kind() -> None:
    """`CHECK` расширяется до трёх видов — тем же набором, что держит модель."""
    module = migration()

    for kind in INVOICE_ITEM_KINDS:
        assert f"'{kind}'" in module.UPGRADE_ITEM_KIND_SQL, kind
    assert "'seats'" in module.UPGRADE_ITEM_KIND_SQL
    # Откат возвращает прежний набор и мест в нём нет.
    assert "'seats'" not in module.DOWNGRADE_ITEM_KIND_SQL
    assert "'tariff'" in module.DOWNGRADE_ITEM_KIND_SQL
    assert "'solution'" in module.DOWNGRADE_ITEM_KIND_SQL


def invoice_table() -> sa.Table:
    """Таблица `invoices` как `Table`: `__table__` у модели типизирован шире."""
    return cast(sa.Table, Invoice.__table__)


def test_the_item_kind_check_is_named_as_the_model_declares() -> None:
    """Имя ограничения в DDL и в модели одно: иначе `downgrade` не найдёт его."""
    module = migration()
    model_checks = {
        constraint.name
        for constraint in invoice_table().constraints
        if isinstance(constraint, sa.CheckConstraint)
    }

    assert module.ITEM_KIND_CHECK in model_checks
    assert Invoice.__tablename__ == module.ITEM_KIND_TABLE


def test_the_quantity_check_is_the_one_the_model_declares() -> None:
    """Имя и условие ограничения совпадают с моделью: расхождение ломает откат."""
    module = migration()
    checks = {
        str(constraint.name): str(constraint.sqltext)
        for constraint in invoice_table().constraints
        if isinstance(constraint, sa.CheckConstraint)
    }

    assert module.QUANTITY_CHECK in checks
    assert " ".join(str(checks[module.QUANTITY_CHECK]).split()) == module.QUANTITY_CHECK_SQL


def test_seed_is_inserted_once_and_does_not_duplicate() -> None:
    """Повторный прогон шага не падает на `UNIQUE(name)` и второй строки не плодит."""
    module = migration()
    engine = sa.create_engine("sqlite://")
    try:
        Base.metadata.create_all(engine)
        with engine.begin() as connection:
            connection.execute(sa.text(module.SEED_EXTRA_MEMBER_SQL))
            connection.execute(sa.text(module.SEED_EXTRA_MEMBER_SQL))

            rows = list(connection.execute(sa.select(Solution)).mappings())

        assert len(rows) == 1
        row = rows[0]
        assert row["code"] == SEED_CODE
        assert row["name"] == SEED_NAME
        assert str(row["amount"]) == SEED_AMOUNT
        assert row["currency"] == "RUB"
        assert row["period"] == SEED_PERIOD
        assert row["position"] == SEED_POSITION
        assert row["is_visible"] is True
        assert "живёт вместе с подпиской" in str(row["description"])
    finally:
        engine.dispose()


def test_downgrade_removes_only_the_seed_row() -> None:
    """Откат снимает ровно строку мест и не трогает прежние решения каталога."""
    module = migration()
    engine = sa.create_engine("sqlite://")
    try:
        Base.metadata.create_all(engine)
        with engine.begin() as connection:
            connection.execute(
                sa.insert(Solution).values(
                    code="journal",
                    name="Журнал действий",
                    amount="300.00",
                    currency="RUB",
                    period="month",
                    position=2,
                    is_visible=True,
                )
            )
            connection.execute(sa.text(module.SEED_EXTRA_MEMBER_SQL))
            connection.execute(sa.text(module.DELETE_EXTRA_MEMBER_SQL))

            codes = list(connection.scalars(sa.select(Solution.code).order_by(Solution.code)))

        assert codes == ["journal"]
    finally:
        engine.dispose()
