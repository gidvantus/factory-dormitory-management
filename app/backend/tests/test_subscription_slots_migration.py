"""Ревизия `0051_subscription_slots`: слоты подписки и backfill срока.

Проверяется то, чего не видно в юнит-тестах моделей: набор колонок совпадает с
моделью организации, у будущего тарифа есть внешний ключ с `ON DELETE SET NULL`
(удаление строки прайса не ломает организацию), откат снимает ровно добавленное и
**backfill**: уже проданным тарифам проставляется срок по их периоду, иначе все
действующие кабинеты закрылись бы в момент выкатки. Период `once` остаётся
бессрочным, повторный backfill уже проставленный срок не сдвигает.

DDL этой ревизии на SQLite не прогоняется (`ADD COLUMN IF NOT EXISTS` и
`REFERENCES` понимает PostgreSQL), поэтому backfill вызывается напрямую на
синтетической схеме — он и есть предмет проверки. Сама DDL проверяется на стенде:
`alembic upgrade head` и `alembic downgrade -1`.
"""

from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa

from app.models.organization import Organization
from tests.migration_support import (
    added_columns,
    assert_on_previous_head,
    assert_single_head,
    column_type_sql,
    dropped_columns,
    load_migration,
    normalized,
)

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic/versions"
ALEMBIC_DIR = BACKEND / "alembic"

REVISION = "0051_subscription_slots"
PARENT = "0050_tariff_settings"

# Колонки слотов, которые заводит ревизия.
NEW_COLUMNS = ("tariff_ends_at", "next_tariff_id", "next_tariff_ends_at")

# Момент выкатки: срок считается от него, поэтому он передаётся явно.
MOMENT = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)


def migration() -> ModuleType:
    return load_migration(VERSIONS / f"{REVISION}.py")


def build_schema(connection: sa.Connection) -> None:
    """Схема до ревизии: организация со ссылкой на тариф и сам прайс."""
    metadata = sa.MetaData()
    sa.Table(
        "tariffs",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("period", sa.String(10), nullable=False),
    )
    sa.Table(
        "organizations",
        metadata,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tariff_id", sa.Integer(), nullable=True),
        # Колонку заводит сама ревизия; в тесте она есть заранее, потому что
        # backfill вызывается напрямую, без DDL.
        sa.Column("tariff_ends_at", sa.DateTime(timezone=True), nullable=True),
    )
    metadata.create_all(connection)


def seed(connection: sa.Connection) -> dict[str, int]:
    """Пять тарифов с разными периодами и по организации на каждый."""
    tariffs = sa.Table("tariffs", sa.MetaData(), autoload_with=connection)
    organizations = sa.Table("organizations", sa.MetaData(), autoload_with=connection)
    periods = ("month", "quarter", "half_year", "year", "once")
    ids: dict[str, int] = {}
    for index, period in enumerate(periods, start=1):
        # Идентификаторы заданы явно: имена и ссылки тесту нужны стабильные.
        connection.execute(tariffs.insert(), {"id": index, "period": period})
        connection.execute(organizations.insert(), {"id": index, "tariff_id": index})
        ids[period] = index
    # Организация без тарифа: backfill её не трогает.
    connection.execute(organizations.insert(), {"id": len(periods) + 1, "tariff_id": None})
    return ids


def ends_at(connection: sa.Connection, organization_id: int) -> datetime | None:
    """Срок организации. SQLite отдаёт naive datetime — считаем его UTC."""
    organizations = sa.Table("organizations", sa.MetaData(), autoload_with=connection)
    value = connection.scalar(
        sa.select(organizations.c.tariff_ends_at).where(organizations.c.id == organization_id)
    )
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def test_revision_stands_on_the_single_current_head() -> None:
    assert_on_previous_head(migration(), REVISION, PARENT)
    assert_single_head(ALEMBIC_DIR)


def test_added_columns_match_the_model() -> None:
    parsed = added_columns(migration())

    assert set(parsed) == set(NEW_COLUMNS)
    for name, declared in parsed.items():
        column = Organization.__table__.columns[name]
        assert declared.upper().startswith(column_type_sql(column)), name


def test_future_tariff_reference_does_not_lock_the_prays() -> None:
    """`ON DELETE SET NULL`: удаление тарифа из прайса не должно ломать организацию."""
    parsed = added_columns(migration())
    declared = normalized(parsed["next_tariff_id"]).upper()

    assert "REFERENCES TARIFFS(ID)" in declared
    assert "ON DELETE SET NULL" in declared
    assert Organization.__table__.columns["next_tariff_id"].nullable is True


def test_added_columns_are_nullable() -> None:
    """`NULL` — нормальное состояние: тариф ещё не оплачен или он бессрочный."""
    for name in NEW_COLUMNS:
        assert Organization.__table__.columns[name].nullable is True, name


def test_downgrade_removes_only_the_added_columns() -> None:
    assert set(dropped_columns(migration())) == set(NEW_COLUMNS)


def test_future_tariff_reference_has_the_model_index() -> None:
    """Индекс объявлен в модели — ревизия обязана завести его же.

    Иначе схема боевой базы расходится с моделью: в тестах `create_all` создаёт
    индекс сам, а в PostgreSQL после `upgrade head` его нет, и `ON DELETE SET
    NULL` при удалении строки прайса идёт по `organizations` без индекса.
    """
    module = migration()
    create_sql = normalized(module.CREATE_INDEX_SQL)
    drop_sql = normalized(module.DROP_INDEX_SQL)

    assert "CREATE INDEX IF NOT EXISTS ix_organizations_next_tariff_id" in create_sql
    assert "ON organizations (next_tariff_id)" in create_sql
    # Откат снимает ровно этот индекс: забытый `drop_index` оставил бы его на
    # снятой колонке и уронил следующий `downgrade`.
    assert drop_sql == "DROP INDEX IF EXISTS ix_organizations_next_tariff_id"
    assert Organization.__table__.columns["next_tariff_id"].index is True


def test_backfill_gives_the_sold_tariffs_their_period() -> None:
    """Срок считается от момента выкатки по периоду тарифа."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_schema(connection)
        ids = seed(connection)

        migration().backfill_tariff_ends_at(connection, MOMENT)

        assert ends_at(connection, ids["month"]) == datetime(2026, 12, 2, 12, 0, tzinfo=UTC)
        assert ends_at(connection, ids["quarter"]) == datetime(2027, 2, 2, 12, 0, tzinfo=UTC)
        assert ends_at(connection, ids["half_year"]) == datetime(2027, 5, 2, 12, 0, tzinfo=UTC)
        assert ends_at(connection, ids["year"]) == datetime(2027, 11, 2, 12, 0, tzinfo=UTC)
        # `once` продаётся бессрочно: `NULL` и есть его срок.
        assert ends_at(connection, ids["once"]) is None
    engine.dispose()


def test_backfill_does_not_move_an_existing_end() -> None:
    """Повторный шаг после обрыва не сдвигает уже оплаченный срок."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_schema(connection)
        ids = seed(connection)
        organizations = sa.Table("organizations", sa.MetaData(), autoload_with=connection)
        fixed = datetime(2027, 1, 1, 0, 0, tzinfo=UTC)
        connection.execute(
            organizations.update()
            .where(organizations.c.id == ids["month"])
            .values(tariff_ends_at=fixed)
        )
        module = migration()

        module.backfill_tariff_ends_at(connection, MOMENT)
        module.backfill_tariff_ends_at(connection, MOMENT)

        assert ends_at(connection, ids["month"]) == fixed
        assert ends_at(connection, ids["quarter"]) == datetime(2027, 2, 2, 12, 0, tzinfo=UTC)
    engine.dispose()


def test_backfill_shortens_the_end_of_the_month() -> None:
    """31 января плюс месяц — 28 февраля, а не 3 марта: срок не удлиняется."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_schema(connection)
        ids = seed(connection)

        migration().backfill_tariff_ends_at(connection, datetime(2026, 1, 31, 12, 0, tzinfo=UTC))

        assert ends_at(connection, ids["month"]) == datetime(2026, 2, 28, 12, 0, tzinfo=UTC)
    engine.dispose()
