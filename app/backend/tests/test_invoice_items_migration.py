"""Ревизия `0066_invoice_items`: таблица позиций и бэкфилл исторических счетов.

Проверяется то, чего не видно в тестах ручек:

* родитель ревизии и одна голова дерева: `alembic upgrade head` обязан остаться
  работоспособным;
* набор колонок совпадает с моделью `InvoiceItem` — колонка модели без DDL
  падала бы в работе;
* имена и условия ограничений совпадают с моделью: `UNIQUE (invoice_id,
  position)`, `CHECK` на набор видов и `CHECK` на количество. Имя `CHECK` не
  отражается SQLite, поэтому сверяется с объявленным в модели;
* бэкфилл даёт **ровно одну** позицию на каждый существующий счёт из его же
  снимка, а сумма позиций у всех счетов равна `invoices.amount`;
* цена единицы у счёта за места восстанавливается как `amount / quantity`, а у
  тарифа и решения равна сумме;
* повторный прогон бэкфилла (обрыв) позиции не задваивает;
* откат снимает таблицу целиком.

DDL `op.create_table` на SQLite прогоняется настоящим `op`; внешние ключи SQLite
не проверяет, и каскад `ON DELETE CASCADE` проверяется на стенде, как и остальной
DDL (`alembic upgrade head` → `downgrade -2` → `upgrade head`).
"""

from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from typing import cast

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.models.base import Base
from app.models.invoice import Invoice, InvoiceItem
from tests.migration_support import (
    assert_on_previous_head,
    assert_single_head,
    load_migration,
    with_operations,
)

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic/versions"
ALEMBIC_DIR = BACKEND / "alembic"

REVISION = "0066_invoice_items"
PARENT = "0065_license_prices"

# Счета, которые видит бэкфилл: тариф, решение и докупленные места.
TARIFF_INVOICE_ID = 1
SOLUTION_INVOICE_ID = 2
SEATS_INVOICE_ID = 3


def migration() -> ModuleType:
    return load_migration(VERSIONS / f"{REVISION}.py")


@pytest.fixture
def connection() -> Iterator[sa.Connection]:
    """Схема из моделей без таблицы позиций и с настоящим `op` внутри ревизии.

    `invoice_items` снимается до ревизии: `Base.metadata.create_all` создал бы
    её из модели, и `op.create_table` упал бы на существующей таблице. Тест
    проверяет именно DDL миграции, поэтому таблицу строит она.
    """
    engine = sa.create_engine("sqlite://")
    try:
        Base.metadata.create_all(engine)
        items_table().drop(engine)
        with engine.begin() as conn:
            seed_invoices(conn)
            yield conn
    finally:
        engine.dispose()


def with_revision(connection: sa.Connection) -> ModuleType:
    return with_operations(migration(), Operations(MigrationContext.configure(connection)))


def invoices_table() -> sa.Table:
    """Таблица `invoices` как `Table`: `__table__` у модели типизирован шире."""
    return cast(sa.Table, Invoice.__table__)


def items_table() -> sa.Table:
    """Таблица `invoice_items` как `Table` — та же причина."""
    return cast(sa.Table, InvoiceItem.__table__)


def seed_invoices(connection: sa.Connection) -> None:
    """Счета в том виде, в каком их оставили прежние ревизии.

    Позиций у них нет по определению: таблицы ещё не существует. Счета за
    решение и за места заполняют ссылки по-разному — бэкфилл должен перенести их
    в позицию как есть.
    """
    invoices = invoices_table()
    connection.execute(
        sa.insert(invoices).values(
            id=TARIFF_INVOICE_ID,
            organization_id=1,
            item_kind="tariff",
            number="СЧ-2026-1",
            status="new",
            amount=Decimal("10000.00"),
            currency="RUB",
            tariff_name="Старт",
            tariff_period="month",
            tariff_id=11,
        )
    )
    connection.execute(
        sa.insert(invoices).values(
            id=SOLUTION_INVOICE_ID,
            organization_id=1,
            item_kind="solution",
            number="СЧ-2026-2",
            status="paid",
            amount=Decimal("500.00"),
            currency="RUB",
            tariff_name="Уведомления в Telegram",
            tariff_period="month",
            solution_id=21,
        )
    )
    connection.execute(
        sa.insert(invoices).values(
            id=SEATS_INVOICE_ID,
            organization_id=1,
            item_kind="seats",
            number="СЧ-2026-3",
            status="new",
            amount=Decimal("2700.00"),
            currency="RUB",
            tariff_name="Дополнительные сотрудники",
            tariff_period="once",
            quantity=3,
            solution_id=22,
        )
    )


def position_rows(connection: sa.Connection) -> list[dict[str, object]]:
    table = sa.Table("invoice_items", sa.MetaData(), autoload_with=connection)
    rows = connection.execute(
        sa.select(table).order_by(table.c.invoice_id, table.c.position)
    ).mappings()
    return [dict(row) for row in rows]


def test_revision_stands_on_the_expected_parent() -> None:
    """Родитель — ревизия прайса этой же задачи, а не номер из постановки."""
    assert_on_previous_head(migration(), REVISION, PARENT)


def test_the_revision_tree_has_exactly_one_head() -> None:
    assert_single_head(ALEMBIC_DIR)


def test_columns_match_the_model(connection: sa.Connection) -> None:
    """Колонка модели без DDL — `UndefinedColumn` в работе, лишняя колонка — мусор."""
    with_revision(connection).upgrade()

    reflected = sa.Table("invoice_items", sa.MetaData(), autoload_with=connection)
    declared = items_table()
    assert set(reflected.columns.keys()) == set(declared.columns.keys())
    for name, column in declared.columns.items():
        assert reflected.columns[name].nullable == column.nullable, name
        assert str(reflected.columns[name].type).upper() == str(column.type).upper(), name


def test_constraint_names_and_conditions_match_the_model(connection: sa.Connection) -> None:
    """Имена ограничений и условия — те же, что объявляет модель."""
    module = with_revision(connection)
    module.upgrade()

    checks = {
        str(constraint.name): " ".join(str(constraint.sqltext).split())
        for constraint in items_table().constraints
        if isinstance(constraint, sa.CheckConstraint)
    }
    uniques = {
        str(constraint.name)
        for constraint in items_table().constraints
        if isinstance(constraint, sa.UniqueConstraint)
    }

    assert uniques == {module.UNIQUE_NAME}
    assert set(checks) == {module.KIND_CHECK, module.QUANTITY_CHECK}
    assert checks[module.KIND_CHECK] == f"kind IN ({module.ITEM_KINDS_SQL})"
    assert checks[module.QUANTITY_CHECK] == module.QUANTITY_CHECK_SQL


def test_columns_cover_the_model_columns_of_the_table() -> None:
    """Модель объявляет ровно тот набор колонок, который перечисляет миграция."""
    assert set(InvoiceItem.__table__.columns.keys()) == {
        "id",
        "invoice_id",
        "position",
        "kind",
        "name",
        "period",
        "quantity",
        "unit_amount",
        "amount",
        "tariff_id",
        "solution_id",
    }


def test_backfill_gives_every_invoice_exactly_one_position(connection: sa.Connection) -> None:
    """Исторический счёт читается одной позицией своего вида и своего снимка."""
    with_revision(connection).upgrade()

    rows = position_rows(connection)

    assert [row["invoice_id"] for row in rows] == [
        TARIFF_INVOICE_ID,
        SOLUTION_INVOICE_ID,
        SEATS_INVOICE_ID,
    ]
    for row in rows:
        assert row["position"] == 1
    tariff, solution, seats = rows
    assert tariff["kind"] == "tariff"
    assert tariff["name"] == "Старт"
    assert tariff["period"] == "month"
    assert tariff["quantity"] is None
    assert Decimal(str(tariff["amount"])) == Decimal("10000.00")
    assert Decimal(str(tariff["unit_amount"])) == Decimal("10000.00")
    assert tariff["tariff_id"] == 11
    assert tariff["solution_id"] is None

    assert solution["kind"] == "solution"
    assert solution["name"] == "Уведомления в Telegram"
    assert solution["solution_id"] == 21
    assert Decimal(str(solution["unit_amount"])) == Decimal("500.00")

    assert seats["kind"] == "seats"
    assert seats["quantity"] == 3
    assert Decimal(str(seats["amount"])) == Decimal("2700.00")
    # Цена единицы у счёта за места — сумма, делённая на количество.
    assert Decimal(str(seats["unit_amount"])) == Decimal("900.00")


def test_the_positions_add_up_to_the_invoice_amount(connection: sa.Connection) -> None:
    """`invoices.amount` остаётся канонической суммой и равен сумме позиций."""
    with_revision(connection).upgrade()

    invoices = invoices_table()
    for invoice_id in (TARIFF_INVOICE_ID, SOLUTION_INVOICE_ID, SEATS_INVOICE_ID):
        total: object = connection.execute(
            sa.text("SELECT sum(amount) FROM invoice_items WHERE invoice_id = :invoice_id"),
            {"invoice_id": invoice_id},
        ).scalar_one()
        amount: object = connection.execute(
            sa.select(invoices.c.amount).where(invoices.c.id == invoice_id)
        ).scalar_one()
        assert Decimal(str(total)) == Decimal(str(amount))


def test_backfill_does_not_duplicate_positions(connection: sa.Connection) -> None:
    """Повторный прогон бэкфилла (обрыв миграции) не задваивает строки."""
    module = with_revision(connection)
    module.upgrade()

    connection.execute(module.BACKFILL_SQL)

    assert len(position_rows(connection)) == 3


def test_downgrade_removes_the_table(connection: sa.Connection) -> None:
    """Откат снимает таблицу: читатели без позиций отдают снимок счёта."""
    revision = with_revision(connection)
    revision.upgrade()

    revision.downgrade()

    assert not sa.inspect(connection).has_table("invoice_items")
