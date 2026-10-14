"""Миграция `0035_solutions` на синтетической схеме.

Проверяется ровно то, чего не видно в юнит-тестах моделей: ревизия применяется
поверх настоящего счёта, существующие счета получают `item_kind = 'tariff'`,
seed-строка каталога появляется один раз, а `downgrade` убирает обе таблицы и обе
колонки, не тронув прежние счета; повторный шаг после отката снова приводит схему
к целевой и не дублирует строку каталога.

Схема собирается по шагам: сначала минимальные `organizations` и `tariffs`, затем
настоящая ревизия `0031_invoices` создаёт `invoices` так же, как на живой базе.
Так таблица счетов приходит к шагу `0035` в своём действительном виде, а не в
упрощённой копии, собранной руками.

Прогон идёт на SQLite: там `batch_alter_table` пересоздаёт таблицу копированием,
и это честная проверка того, что шаг не зависит от `ALTER TABLE ... ADD
CONSTRAINT`. Настоящая PostgreSQL проверяется на стенде (`alembic upgrade head`
и `downgrade -1`).
"""

from datetime import datetime
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

VERSIONS = Path(__file__).resolve().parents[1] / "alembic/versions"

SEED_CODE = "telegram_notifications"


def load_migration(module_name: str, filename: str) -> ModuleType:
    """Загрузить файл ревизии как модуль — так же, как это делает Alembic."""
    spec = spec_from_file_location(module_name, VERSIONS / filename)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_with_operations(module: ModuleType, operations: Operations) -> ModuleType:
    """Подставить ревизии рабочий `op`.

    `setattr`, а не `module.op = operations`: у `ModuleType` объявленного атрибута
    `op` нет, и присваивание добавило бы ошибку типизатора. Alembic делает то же
    самое, подставляя прокси в глобальное имя модуля.
    """
    setattr(module, "op", operations)  # noqa: B010 - см. докстринг: так требует mypy
    return module


def test_migration_adds_the_catalog_and_marks_existing_invoices() -> None:
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        metadata = sa.MetaData()
        sa.Table("organizations", metadata, sa.Column("id", sa.Integer(), primary_key=True))
        sa.Table("tariffs", metadata, sa.Column("id", sa.Integer(), primary_key=True))
        metadata.create_all(connection)

        operations = Operations(MigrationContext.configure(connection))
        invoices_migration = run_with_operations(
            load_migration("invoices_migration", "0031_invoices.py"), operations
        )
        invoices_migration.upgrade()

        invoices = sa.Table("invoices", sa.MetaData(), autoload_with=connection)
        connection.execute(
            invoices.insert(),
            [
                {
                    "organization_id": 1,
                    "tariff_id": None,
                    "number": "СЧ-2026-1",
                    "status": "paid",
                    "amount": "10000.00",
                    "currency": "RUB",
                    "tariff_name": "Старт",
                    "tariff_period": "month",
                },
                {
                    "organization_id": 1,
                    "tariff_id": None,
                    "number": "СЧ-2026-2",
                    "status": "new",
                    "amount": "50000.00",
                    "currency": "RUB",
                    "tariff_name": "Стандарт",
                    "tariff_period": "half_year",
                },
            ],
        )

        migration = run_with_operations(
            load_migration("solutions_migration", "0035_solutions.py"), operations
        )
        migration.upgrade()

        tables = sa.inspect(connection).get_table_names()
        assert "solutions" in tables
        assert "organization_solutions" in tables

        solutions = sa.Table("solutions", sa.MetaData(), autoload_with=connection)
        rows = list(connection.execute(sa.select(solutions)).mappings())
        assert len(rows) == 1
        assert rows[0]["code"] == SEED_CODE
        assert rows[0]["name"] == "Уведомления в Telegram"
        assert str(rows[0]["amount"]) == "500.00"
        assert rows[0]["currency"] == "RUB"
        assert rows[0]["period"] == "month"
        assert rows[0]["position"] == 1
        assert bool(rows[0]["is_visible"]) is True

        # Прежние счета становятся тарифными: иных предметов до ревизии не было.
        invoices = sa.Table("invoices", sa.MetaData(), autoload_with=connection)
        assert set(connection.scalars(sa.select(invoices.c.item_kind))) == {"tariff"}
        assert set(connection.scalars(sa.select(invoices.c.solution_id))) == {None}
        assert connection.scalar(sa.select(sa.func.count()).select_from(invoices)) == 2

        rights = sa.Table("organization_solutions", sa.MetaData(), autoload_with=connection)
        connection.execute(
            rights.insert(),
            {
                "organization_id": 1,
                "solution_id": rows[0]["id"],
                "granted_at": datetime(2026, 10, 14, 10, 0, 0),
                "expires_at": datetime(2026, 11, 14, 10, 0, 0),
                "invoice_id": 1,
            },
        )
        assert connection.scalar(sa.select(sa.func.count()).select_from(rights)) == 1

        migration.downgrade()

        tables = sa.inspect(connection).get_table_names()
        assert "solutions" not in tables
        assert "organization_solutions" not in tables

        invoices = sa.Table("invoices", sa.MetaData(), autoload_with=connection)
        assert "item_kind" not in invoices.c
        assert "solution_id" not in invoices.c
        assert connection.scalar(sa.select(sa.func.count()).select_from(invoices)) == 2
        assert list(connection.scalars(sa.select(invoices.c.number).order_by(invoices.c.id))) == [
            "СЧ-2026-1",
            "СЧ-2026-2",
        ]
        names = sa.select(invoices.c.tariff_name).order_by(invoices.c.id)
        assert list(connection.scalars(names)) == ["Старт", "Стандарт"]
        assert list(connection.scalars(sa.select(invoices.c.status).order_by(invoices.c.id))) == [
            "paid",
            "new",
        ]

        # И повторный шаг после отката снова приводит схему к целевой, а строка
        # каталога не дублируется: вставка идемпотентна по `code`.
        migration.upgrade()
        invoices = sa.Table("invoices", sa.MetaData(), autoload_with=connection)
        assert set(connection.scalars(sa.select(invoices.c.item_kind))) == {"tariff"}
        solutions = sa.Table("solutions", sa.MetaData(), autoload_with=connection)
        assert connection.scalar(sa.select(sa.func.count()).select_from(solutions)) == 1
        assert connection.scalar(sa.select(solutions.c.code)) == SEED_CODE
    engine.dispose()
