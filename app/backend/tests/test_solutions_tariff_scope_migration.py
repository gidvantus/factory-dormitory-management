"""Миграция `0068_solutions_tariff_scope` на синтетической схеме.

Проверяется ровно то, чего не видно в юнит-тестах моделей: ревизия приводит к
`period = 'once'` **все** строки каталога (включая значение, выставленное
оператором через кабинет #188), не трогает прочие колонки, а `downgrade`
возвращает `month` только двум seed-строкам — значений оператора он не знает и
восстановить не может.

Прогон идёт на SQLite: там `UPDATE` проверяется построчно, а настоящая PostgreSQL
проходит шаг на стенде (`alembic upgrade head`, `alembic downgrade -1`).
"""

from decimal import Decimal

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.test_solutions_migration import load_migration, run_with_operations

REVISION = "0068_solutions_tariff_scope.py"

# Строки каталога до шага: две seed-строки (месячные) и правка оператора.
SEED_ROWS = (
    {
        "code": "telegram_notifications",
        "name": "Уведомления в Telegram",
        "period": "month",
        "amount": "500.00",
        "currency": "RUB",
        "position": 1,
    },
    {
        "code": "journal",
        "name": "Журнал действий",
        "period": "month",
        "amount": "300.00",
        "currency": "RUB",
        "position": 2,
    },
    {
        "code": "extra_member",
        "name": "Дополнительные сотрудники",
        "period": "year",
        "amount": "1500.00",
        "currency": "RUB",
        "position": 3,
    },
)


def catalog(connection: sa.Connection) -> dict[str, dict[str, object]]:
    solutions = sa.Table("solutions", sa.MetaData(), autoload_with=connection)
    rows = connection.execute(
        sa.select(solutions).order_by(solutions.c.position, solutions.c.id)
    ).mappings()
    return {str(row["code"]): dict(row) for row in rows}


def test_migration_normalizes_every_catalog_row() -> None:
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        metadata = sa.MetaData()
        created_at = sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        )
        updated_at = sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        )
        sa.Table(
            "solutions",
            metadata,
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("code", sa.String(40), nullable=False, unique=True),
            sa.Column("name", sa.String(120), nullable=False, unique=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("amount", sa.Numeric(10, 2), nullable=False),
            sa.Column("currency", sa.String(3), nullable=False),
            sa.Column("period", sa.String(10), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False),
            sa.Column("is_visible", sa.Boolean(), nullable=False),
            created_at,
            updated_at,
        )
        metadata.create_all(connection)
        solutions = sa.Table("solutions", sa.MetaData(), autoload_with=connection)
        connection.execute(solutions.insert(), [dict(row, is_visible=True) for row in SEED_ROWS])

        operations = Operations(MigrationContext.configure(connection))
        migration = run_with_operations(
            load_migration("solutions_tariff_scope", REVISION), operations
        )
        migration.upgrade()

        rows = catalog(connection)
        assert {code: row["period"] for code, row in rows.items()} == {
            "telegram_notifications": "once",
            "journal": "once",
            "extra_member": "once",
        }
        # Остальные поля шаг не трогает: это нормализация одного столбца.
        assert rows["journal"]["amount"] == Decimal("300.00")
        assert rows["journal"]["name"] == "Журнал действий"
        assert rows["extra_member"]["position"] == 3

        migration.downgrade()

        rows = catalog(connection)
        # Откат знает только про две seed-строки: значение оператора (`year`) он
        # не восстановит — так и записано в докстринге ревизии.
        assert {code: row["period"] for code, row in rows.items()} == {
            "telegram_notifications": "month",
            "journal": "month",
            "extra_member": "once",
        }

        # Повторный шаг снова приводит каталог к целевому состоянию: ревизия
        # идемпотентна по условию `period <> 'once'`.
        migration.upgrade()
        assert {row["period"] for row in catalog(connection).values()} == {"once"}
    engine.dispose()
