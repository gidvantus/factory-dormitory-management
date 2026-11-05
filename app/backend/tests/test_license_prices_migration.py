"""Ревизия `0065_license_prices`: две лицензии, скрытые ярусы и цена места.

Проверяется то, чего не видно в тестах ручек: юнит-прогон собирает схему из
моделей, а прайс живёт данными, и заводит его ревизия.

Что здесь проверяется:

* родитель — фактическая голова после мержа #168 (`0064_extra_seats`), а не
  номер из постановки;
* после `upgrade` видимых строк прайса ровно две: 6 месяцев за 60 000 ₽ с
  пятью сотрудниками и 12 месяцев за 100 000 ₽ с десятью. Ярусы «Старт»,
  «Рост», «Команда» и «Безлимит» из витрины ушли, но остались в таблице:
  на них стоят привязки организаций и ссылки счетов;
* вставка идемпотентна: повторный прогон шага (обрыв миграции) не падает на
  `UNIQUE(name)` и второй строки не плодит;
* цена места приведена к 1 500 ₽;
* откат снимает лицензии, возвращает видимость ярусам и прежнюю цену места
  900 ₽, но **не** включает исторические строки «Старт (прежний прайс)»,
  «Стандарт» и «Максимум»: у них `group_code IS NULL`, и шаг их не прятал.

DDL здесь не нужен — ревизия меняет данные, поэтому она целиком прогоняется на
SQLite настоящим `op` (как ревизии `documents` в `migration_support`).
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
from app.models.tariff import Tariff
from tests.migration_support import (
    assert_on_previous_head,
    assert_single_head,
    load_migration,
    with_operations,
)

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic/versions"
ALEMBIC_DIR = BACKEND / "alembic"

REVISION = "0065_license_prices"
PARENT = "0064_extra_seats"

HALF_YEAR_NAME = "Домовой · 6 месяцев"
YEAR_NAME = "Домовой · 12 месяцев"

# Подсказка к карточке: тот же текст, что у ярусов `0052`.
SEATS_TOOLTIP = "Место — сотрудник с доступом к кабинету. Проживающие не считаются."

# Прежняя сетка `0052_tariff_prices`: код яруса, имя и цена месячной строки.
TIER_ROWS = (
    ("start", "Старт", "4900.00", 5),
    ("growth", "Рост", "9900.00", 15),
    ("team", "Команда", "14900.00", 30),
    ("unlimited", "Безлимит", "19900.00", None),
)

# Исторические строки с `group_code IS NULL`: они и до этой ревизии были скрыты,
# и откат обязан оставить их скрытыми.
HISTORICAL_NAMES = ("Старт (прежний прайс)", "Стандарт", "Максимум")


def migration() -> ModuleType:
    return load_migration(VERSIONS / f"{REVISION}.py")


def tariffs_table() -> sa.Table:
    """Таблица `tariffs` как `Table`: `__table__` у модели типизирован шире."""
    return cast(sa.Table, Tariff.__table__)


@pytest.fixture
def connection() -> Iterator[sa.Connection]:
    """Пустая схема из моделей и подключение с настоящим `op` внутри ревизии."""
    engine = sa.create_engine("sqlite://")
    try:
        Base.metadata.create_all(engine)
        with engine.begin() as conn:
            yield conn
    finally:
        engine.dispose()


def with_revision(connection: sa.Connection) -> ModuleType:
    return with_operations(migration(), Operations(MigrationContext.configure(connection)))


def seed_prices(connection: sa.Connection) -> None:
    """Прежний прайс в том виде, в каком он лежит на живой базе после `0052`."""
    tariffs = tariffs_table()
    for group_code, name, amount, max_members in TIER_ROWS:
        connection.execute(
            sa.insert(tariffs).values(
                name=name,
                amount=amount,
                currency="RUB",
                period="month",
                position=1,
                group_code=group_code,
                max_members=max_members,
                is_visible=True,
            )
        )
    for name in HISTORICAL_NAMES:
        connection.execute(
            sa.insert(tariffs).values(
                name=name,
                amount="1000.00",
                currency="RUB",
                period="month",
                position=0,
                group_code=None,
                is_visible=False,
            )
        )
    connection.execute(
        sa.text(
            "INSERT INTO solutions (code, name, description, amount, currency, period, "
            "position, is_visible) VALUES ('extra_member', 'Дополнительные сотрудники', "
            "'Место живёт вместе с подпиской.', 900.00, 'RUB', 'once', 900, true)"
        )
    )


def visible_rows(connection: sa.Connection) -> list[tuple[str, str, Decimal, int | None]]:
    """Видимые строки прайса: имя, период, сумма и предел мест."""
    table = tariffs_table()
    rows = connection.execute(
        sa.select(table.c.name, table.c.period, table.c.amount, table.c.max_members)
        .where(table.c.is_visible.is_(True))
        .order_by(table.c.position)
    ).mappings()
    return [
        (str(row["name"]), str(row["period"]), row["amount"], row["max_members"]) for row in rows
    ]


def license_rows(connection: sa.Connection) -> list[dict[str, object]]:
    """Строки витрины этой задачи: всё, у чего `group_code = 'license'`."""
    table = tariffs_table()
    rows = connection.execute(
        sa.select(table).where(table.c.group_code == "license").order_by(table.c.position)
    ).mappings()
    return [dict(row) for row in rows]


def hidden(connection: sa.Connection, names: tuple[str, ...]) -> list[bool]:
    """Видимость строк по именам — в порядке `names`."""
    table = tariffs_table()
    values: list[object] = list(
        connection.execute(
            sa.select(table.c.is_visible).where(table.c.name.in_(names)).order_by(table.c.name)
        ).scalars()
    )
    return [bool(value) for value in values]


def seat_price(connection: sa.Connection) -> Decimal:
    price: Decimal = connection.execute(
        sa.text("SELECT amount FROM solutions WHERE code = 'extra_member'")
    ).scalar_one()
    return price


def test_revision_stands_on_the_expected_parent() -> None:
    """Родитель — голова `develop-m` после мержа #168, а не номер из постановки."""
    assert_on_previous_head(migration(), REVISION, PARENT)


def test_the_revision_adds_a_single_head() -> None:
    assert_single_head(ALEMBIC_DIR)


def test_upgrade_leaves_exactly_two_licenses_on_the_shelf(connection: sa.Connection) -> None:
    """`GET /api/tariffs` после ревизии отдаёт две лицензии и ничего кроме них."""
    seed_prices(connection)

    with_revision(connection).upgrade()

    assert visible_rows(connection) == [
        (HALF_YEAR_NAME, "half_year", Decimal("60000.00"), 5),
        (YEAR_NAME, "year", Decimal("100000.00"), 10),
    ]


def test_the_license_rows_carry_the_license_group_and_tooltip(connection: sa.Connection) -> None:
    """Код яруса `license` и подсказка про место — как у прежних ярусов."""
    seed_prices(connection)

    with_revision(connection).upgrade()

    rows = license_rows(connection)

    assert len(rows) == 2
    assert [row["position"] for row in rows] == [1, 2]
    assert [row["currency"] for row in rows] == ["RUB", "RUB"]
    assert [row["is_visible"] for row in rows] == [True, True]
    assert [row["tooltip"] for row in rows] == [SEATS_TOOLTIP, SEATS_TOOLTIP]
    assert "6 месяцев" in str(rows[0]["description"])
    assert "12 месяцев" in str(rows[1]["description"])


def test_tiers_are_hidden_but_not_deleted(connection: sa.Connection) -> None:
    """Строки ярусов остаются: к ним привязаны организации и ссылки счетов."""
    seed_prices(connection)

    with_revision(connection).upgrade()

    table = tariffs_table()
    rows = connection.execute(
        sa.select(table.c.name, table.c.is_visible).where(
            table.c.group_code.is_not(None),
            table.c.group_code != "license",
        )
    ).mappings()
    assert {(row["name"], row["is_visible"]) for row in rows} == {
        (name, False) for _, name, _, _ in TIER_ROWS
    }


def test_the_historical_rows_are_left_as_they_were(connection: sa.Connection) -> None:
    """Строки с `group_code IS NULL` шаг не трогает: их прятал другой прайс."""
    seed_prices(connection)

    with_revision(connection).upgrade()

    assert hidden(connection, HISTORICAL_NAMES) == [False, False, False]


def test_upgrade_raises_the_seat_price_to_1500(connection: sa.Connection) -> None:
    """Цена места из #168 (900 ₽) приводится к 1 500 ₽ этой задачей."""
    seed_prices(connection)

    with_revision(connection).upgrade()

    assert seat_price(connection) == Decimal("1500.00")


def test_upgrade_is_idempotent(connection: sa.Connection) -> None:
    """Повторный прогон после обрыва не плодит лицензии и не падает на `UNIQUE`."""
    seed_prices(connection)
    revision = with_revision(connection)

    revision.upgrade()
    revision.upgrade()

    assert len(visible_rows(connection)) == 2
    assert len(license_rows(connection)) == 2


def test_downgrade_restores_the_shelf_and_the_seat_price(connection: sa.Connection) -> None:
    """Откат снимает лицензии, возвращает ярусам видимость и цену места 900 ₽."""
    seed_prices(connection)
    revision = with_revision(connection)
    revision.upgrade()

    revision.downgrade()

    assert license_rows(connection) == []
    visible_names = {name for name, _, _, _ in visible_rows(connection)}
    assert visible_names == {name for _, name, _, _ in TIER_ROWS}
    assert seat_price(connection) == Decimal("900.00")


def test_downgrade_keeps_the_historical_rows_hidden(connection: sa.Connection) -> None:
    """Откат не включает «Старт (прежний прайс)», «Стандарт» и «Максимум»."""
    seed_prices(connection)
    revision = with_revision(connection)
    revision.upgrade()

    revision.downgrade()

    assert hidden(connection, HISTORICAL_NAMES) == [False, False, False]
