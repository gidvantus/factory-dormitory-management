"""Ревизия `0052_tariff_prices`: сетка прайса «ярусы × срок».

Проверяется то, чего не видно в юнит-тестах моделей: ревизия заводит двенадцать
строк сетки, три старые строки `0030` остаются в таблице, но уходят из публичного
прайса (счета и привязки организаций ссылаются на них по `id`), старый «Старт»
уступает имя месячной строке яруса и получает «Старт (прежний прайс)».
Повторный `upgrade` ничего не дублирует и не переименовывает новые строки, а
`downgrade` возвращает ровно прежние три строки.

Данные сверяются дословно: это цены, которые видит человек на `/pricing`, а не
служебные поля. Схема собирается по шагам — сначала минимальные `organizations` и
`tariffs`, затем настоящая `0030_pricing_plans` заводит старые строки, а на неё
ложится расширение `tariffs` этой задачи (колонки яруса уже объявлены в модели,
поэтому таблица создаётся по `0030` и дополняется вручную).

Прогон идёт на SQLite: ревизия состоит только из данных, DDL ей не нужен.
Настоящая PostgreSQL проверяется на стенде (`alembic upgrade head`, `downgrade -1`).
"""

from datetime import datetime
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.migration_support import assert_on_previous_head, assert_single_head, load_migration

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic/versions"
ALEMBIC_DIR = BACKEND / "alembic"

REVISION = "0052_tariff_prices"
PARENT = "0051_subscription_slots"

# Строки прежнего прайса `0030`: имя, период и цена на момент ревизии.
OLD_PLANS = (
    ("Старт", "month", "10000.00"),
    ("Стандарт", "half_year", "50000.00"),
    ("Максимум", "year", "90000.00"),
)

ARCHIVED_START_NAME = "Старт (прежний прайс)"

# Сетка: имя строки, ярус, предел мест, период, позиция и цена.
NEW_PLANS = (
    ("Старт", "start", 5, "month", 11, "4900.00"),
    ("Старт · 3 месяца", "start", 5, "quarter", 12, "13200.00"),
    ("Старт · 12 месяцев", "start", 5, "year", 13, "47000.00"),
    ("Рост", "growth", 15, "month", 21, "9900.00"),
    ("Рост · 3 месяца", "growth", 15, "quarter", 22, "26700.00"),
    ("Рост · 12 месяцев", "growth", 15, "year", 23, "95000.00"),
    ("Команда", "team", 30, "month", 31, "14900.00"),
    ("Команда · 3 месяца", "team", 30, "quarter", 32, "40200.00"),
    ("Команда · 12 месяцев", "team", 30, "year", 33, "143000.00"),
    ("Безлимит", "unlimited", None, "month", 41, "19900.00"),
    ("Безлимит · 3 месяца", "unlimited", None, "quarter", 42, "53700.00"),
    ("Безлимит · 12 месяцев", "unlimited", None, "year", 43, "191000.00"),
)


def migration() -> ModuleType:
    return load_migration(VERSIONS / f"{REVISION}.py")


def with_operations(module: ModuleType, operations: Operations) -> ModuleType:
    """Подставить ревизии рабочий `op` — так же, как это делает Alembic."""
    setattr(module, "op", operations)  # noqa: B010 - см. докстринг: так требует mypy
    return module


def build_prays(connection: sa.Connection) -> None:
    """Схема до `0052`: тарифы `0030` плюс колонки яруса из `0050`."""
    metadata = sa.MetaData()
    sa.Table("organizations", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    sa.Table(
        "tariffs",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="RUB"),
        sa.Column("period", sa.String(10), nullable=False, server_default="month"),
        sa.Column("unit_label", sa.String(40), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_visible", sa.Boolean(), nullable=False, server_default=sa.true()),
        # Колонки яруса (`0050`): в тесте объявлены сразу, чтобы данные ревизии
        # было куда писать без DDL на SQLite.
        sa.Column("max_members", sa.Integer(), nullable=True),
        sa.Column("tooltip", sa.String(200), nullable=True),
        sa.Column("group_code", sa.String(40), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    metadata.create_all(connection)

    operations = Operations(MigrationContext.configure(connection))
    # Настоящая `0030` заводит три старые строки так же, как на живой базе.
    with_operations(load_migration(VERSIONS / "0030_pricing_plans.py"), operations).upgrade()


def prays_rows(connection: sa.Connection) -> list[dict[str, object]]:
    tariffs = sa.Table("tariffs", sa.MetaData(), autoload_with=connection)
    rows = connection.execute(sa.select(tariffs).order_by(tariffs.c.position)).mappings()
    return [dict(row) for row in rows]


def by_name(connection: sa.Connection) -> dict[str, dict[str, object]]:
    return {str(row["name"]): row for row in prays_rows(connection)}


def test_revision_stands_on_the_single_current_head() -> None:
    assert_on_previous_head(migration(), REVISION, PARENT)
    assert_single_head(ALEMBIC_DIR)


def test_upgrade_adds_the_grid_and_keeps_the_old_rows() -> None:
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_prays(connection)
        assert len(prays_rows(connection)) == 3

        with_operations(migration(), Operations(MigrationContext.configure(connection))).upgrade()

        rows = by_name(connection)
        # Три старые строки на месте, двенадцать новых добавлены.
        assert len(rows) == 15
        assert ARCHIVED_START_NAME in rows
        assert {"Стандарт", "Максимум"} <= set(rows)

        for name, group_code, max_members, period, position, amount in NEW_PLANS:
            row = rows[name]
            assert row["group_code"] == group_code, name
            assert row["max_members"] == max_members, name
            assert row["period"] == period, name
            assert row["position"] == position, name
            assert str(row["amount"]) == amount, name
            assert bool(row["is_visible"]) is True, name
            assert row["tooltip"], name
    engine.dispose()


def test_upgrade_hides_the_old_rows_instead_of_deleting_them() -> None:
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_prays(connection)

        with_operations(migration(), Operations(MigrationContext.configure(connection))).upgrade()

        rows = by_name(connection)
        # Старый «Старт» уступил имя месячной строке яруса: `name` уникально.
        archived = rows[ARCHIVED_START_NAME]
        assert bool(archived["is_visible"]) is False
        assert archived["group_code"] is None
        assert str(archived["amount"]) == "10000.00"
        assert archived["period"] == "month"
        for name in ("Стандарт", "Максимум"):
            assert bool(rows[name]["is_visible"]) is False, name
    engine.dispose()


def test_repeated_upgrade_does_not_duplicate_or_rerename() -> None:
    """Идемпотентность: `group_code` отличает новые строки от старых."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_prays(connection)
        operations = Operations(MigrationContext.configure(connection))
        module = with_operations(migration(), operations)

        module.upgrade()
        module.upgrade()

        rows = by_name(connection)
        assert len(rows) == 15
        assert bool(rows["Старт"]["is_visible"]) is True
        assert bool(rows[ARCHIVED_START_NAME]["is_visible"]) is False
    engine.dispose()


def test_downgrade_returns_the_old_prays() -> None:
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_prays(connection)
        operations = Operations(MigrationContext.configure(connection))
        module = with_operations(migration(), operations)
        module.upgrade()

        module.downgrade()

        rows = prays_rows(connection)
        assert len(rows) == 3
        assert [(row["name"], row["period"]) for row in rows] == [
            (name, period) for name, period, _amount in OLD_PLANS
        ]
        assert all(bool(row["is_visible"]) is True for row in rows)
        assert [str(row["amount"]) for row in rows] == [amount for _, _, amount in OLD_PLANS]

        # И повторный шаг снова приводит прайс к сетке.
        module.upgrade()
        assert len(prays_rows(connection)) == 15
    engine.dispose()


def test_old_rows_keep_their_snapshot_for_invoices() -> None:
    """Счёт хранит название и период снимком — переименование строки его не трогает."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_prays(connection)
        invoices = sa.Table(
            "invoices",
            sa.MetaData(),
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("tariff_id", sa.Integer(), nullable=True),
            sa.Column("tariff_name", sa.String(120), nullable=True),
            sa.Column("tariff_period", sa.String(10), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
        invoices.create(connection)
        tariffs = sa.Table("tariffs", sa.MetaData(), autoload_with=connection)
        old_start_id = connection.scalar(sa.select(tariffs.c.id).where(tariffs.c.name == "Старт"))
        connection.execute(
            invoices.insert(),
            {
                "tariff_id": old_start_id,
                "tariff_name": "Старт",
                "tariff_period": "month",
                "created_at": datetime(2026, 10, 1, 12, 0),
            },
        )

        with_operations(migration(), Operations(MigrationContext.configure(connection))).upgrade()

        row = connection.execute(sa.select(invoices)).mappings().one()
        assert row["tariff_name"] == "Старт"
        assert row["tariff_period"] == "month"
        # Ссылка на строку прайса сохранилась: она теперь называется иначе.
        assert row["tariff_id"] == old_start_id
        renamed = connection.scalar(sa.select(tariffs.c.name).where(tariffs.c.id == old_start_id))
        assert renamed == ARCHIVED_START_NAME
    engine.dispose()
