"""Ревизия `0049_solution_journal` на синтетической схеме.

Проверяется ровно то, чего не видно в юнит-тестах: ревизия вставляет вторую строку
каталога и не трогает первую, повторный `upgrade` вторую строку не плодит
(идемпотентность по `code`), а `downgrade` удаляет **ровно** строку `journal`,
оставляя Telegram и всё остальное на месте.

Схема собирается по шагам, как на живой базе: минимальные `organizations` и
`tariffs`, затем настоящая ревизия `0031_invoices` создаёт `invoices`, затем
`0035_solutions` заводит каталог, право организации и seed-строку Telegram — и на
эту готовую схему ложится `0049`. Так `solutions` приходит к шагу `0049` в
действительном виде, а не в упрощённой копии, собранной руками.

Прогон идёт на SQLite: настоящая PostgreSQL проверяется на стенде (`alembic
upgrade head`, `alembic downgrade -1` и снова `alembic upgrade head`).
"""

from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.migration_support import (
    assert_on_previous_head,
    assert_single_head,
    load_migration,
)

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic/versions"
ALEMBIC_DIR = BACKEND / "alembic"

REVISION = "0049_solution_journal"
PARENT = "0048_offer_acceptance"

TELEGRAM_CODE = "telegram_notifications"
JOURNAL_CODE = "journal"

# Строка каталога, которую заводит ревизия: значения сверяются дословно, потому
# что это данные, которые видит человек в магазине, а не служебные поля.
JOURNAL_ROW = {
    "code": JOURNAL_CODE,
    "name": "Журнал действий",
    "description": "Кто, когда и что изменил в кабинете",
    "amount": "300.00",
    "currency": "RUB",
    "period": "month",
    "position": 2,
}


def migration() -> ModuleType:
    return load_migration(VERSIONS / f"{REVISION}.py")


def with_operations(module: ModuleType, operations: Operations) -> ModuleType:
    """Подставить ревизии рабочий `op` — так же, как это делает Alembic.

    `setattr`, а не `module.op = operations`: у `ModuleType` объявленного атрибута
    `op` нет, и присваивание добавило бы ошибку типизатора.
    """
    setattr(module, "op", operations)  # noqa: B010 - см. докстринг: так требует mypy
    return module


def build_catalog(connection: sa.Connection) -> None:
    """Схема до `0049`: каталог решений с одной seed-строкой Telegram."""
    metadata = sa.MetaData()
    sa.Table("organizations", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    sa.Table("tariffs", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    metadata.create_all(connection)

    operations = Operations(MigrationContext.configure(connection))
    for filename in ("0031_invoices.py", "0035_solutions.py"):
        with_operations(load_migration(VERSIONS / filename), operations).upgrade()


def catalog_rows(connection: sa.Connection) -> list[dict[str, object]]:
    solutions = sa.Table("solutions", sa.MetaData(), autoload_with=connection)
    rows = connection.execute(sa.select(solutions).order_by(solutions.c.position)).mappings()
    return [dict(row) for row in rows]


def test_revision_stands_on_the_single_current_head() -> None:
    assert_on_previous_head(migration(), REVISION, PARENT)
    assert_single_head(ALEMBIC_DIR)


def test_upgrade_adds_the_journal_row_and_keeps_telegram() -> None:
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_catalog(connection)
        # Доступное до ревизии состояние: одна seed-строка, заведённая `0035`.
        assert [row["code"] for row in catalog_rows(connection)] == [TELEGRAM_CODE]

        with_operations(migration(), Operations(MigrationContext.configure(connection))).upgrade()

        rows = catalog_rows(connection)
        assert [row["code"] for row in rows] == [TELEGRAM_CODE, JOURNAL_CODE]

        journal = rows[1]
        for field, expected in JOURNAL_ROW.items():
            # Сумма приходит из базы числом (`NUMERIC`), остальные поля — как есть.
            if field == "amount":
                assert str(journal[field]) == expected, field
            else:
                assert journal[field] == expected, field
        assert bool(journal["is_visible"]) is True

        # Строка Telegram не переписана: ревизия только добавляет.
        telegram = rows[0]
        assert telegram["name"] == "Уведомления в Telegram"
        assert str(telegram["amount"]) == "500.00"
        assert telegram["position"] == 1
    engine.dispose()


def test_repeated_upgrade_does_not_duplicate_the_row() -> None:
    """Идемпотентность по `code`: обрыв и повтор не плодят вторую строку журнала."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_catalog(connection)
        operations = Operations(MigrationContext.configure(connection))
        module = with_operations(migration(), operations)

        module.upgrade()
        module.upgrade()

        assert [row["code"] for row in catalog_rows(connection)] == [TELEGRAM_CODE, JOURNAL_CODE]
    engine.dispose()


def test_downgrade_removes_only_the_journal_row() -> None:
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_catalog(connection)
        operations = Operations(MigrationContext.configure(connection))
        module = with_operations(migration(), operations)
        module.upgrade()

        module.downgrade()

        rows = catalog_rows(connection)
        # Осталась ровно одна строка — Telegram; журнал удалён по коду.
        assert [row["code"] for row in rows] == [TELEGRAM_CODE]
        assert str(rows[0]["amount"]) == "500.00"

        # И повторный шаг приводит каталог обратно к двум строкам.
        module.upgrade()
        assert [row["code"] for row in catalog_rows(connection)] == [
            TELEGRAM_CODE,
            JOURNAL_CODE,
        ]
    engine.dispose()
