"""Партиции журнала действий на настоящей PostgreSQL.

Прогон идёт только на стенде: `python -m pytest -q -m dbtest` внутри контейнера
`api`, где `DATABASE_URL` указывает на живой PostgreSQL. В юнит-прогоне эти
тесты не участвуют (`addopts` в `pyproject.toml` снимает метку `dbtest`): SQLite
партиций не умеет, и проверять там нечего.

Проверяется то, чего не видно на SQLite: партиции на текущий и следующие месяцы,
`DEFAULT`-партиция как страховка от пропущенного месяца, физическое размещение
строки текущего месяца в партиции этого месяца и то, что удаление партиции
уносит её строки.

Строки, которые заводит тест, он же и уносит: журнал стенда — настоящий журнал, и
мусорить в нём нечем. Партиции за пределами запаса приложения создаются тестом и
им же удаляются.
"""

from datetime import UTC, date, datetime
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import db as db_module
from app.audit import ensure_partitions, shift_month
from app.config import get_settings

# Далеко за пределами запаса приложения: такая месячная партиция не может
# содержать настоящих строк, поэтому её можно создавать и удалять в тесте.
FAR_AHEAD_MONTHS = 24
# Ещё дальше — и месяца в запасе точно нет: такая строка должна лечь в DEFAULT.
FAR_FUTURE_MONTHS = 600

# Имя `DEFAULT`-партиции: то же правило, что в миграции и в приложении.
DEFAULT_PARTITION = "audit_events_default"

LIST_PARTITIONS_SQL = text(
    "SELECT relname FROM pg_class WHERE relkind = 'r' "
    "AND relname ~ '^audit_events_[0-9]{4}_[0-9]{2}$'"
)

LIST_TABLES_SQL = text("SELECT relname FROM pg_class WHERE relkind = 'r'")

INSERT_EVENT_SQL = text(
    """
    INSERT INTO audit_events (method, path, action, kind, status, duration_ms, request_id)
    VALUES ('POST', '/api/probe', 'post_probe', 'data', 201, 1, :marker)
    """
)

INSERT_OLD_EVENT_SQL = text(
    """
    INSERT INTO audit_events (
        created_at, method, path, action, kind, status, duration_ms, request_id
    )
    VALUES (:created_at, 'POST', '/api/probe', 'post_probe', 'data', 201, 1, :marker)
    """
)

SELECT_PARTITION_SQL = text(
    "SELECT tableoid::regclass::text FROM audit_events WHERE request_id = :marker"
)

COUNT_MARKER_SQL = text("SELECT count(*) FROM audit_events WHERE request_id = :marker")

DELETE_MARKER_SQL = text("DELETE FROM audit_events WHERE request_id = :marker")


def current_month() -> date:
    """Текущий месяц в UTC — тот же, что берёт приложение."""
    return datetime.now(UTC).date().replace(day=1)


def partition_name(month: date) -> str:
    """Имя партиции месяца: то же правило, что в миграции и в приложении."""
    return f"audit_events_{month.year:04d}_{month.month:02d}"


def partitions(db: Session) -> set[str]:
    """Имена месячных партиций по каталогу PostgreSQL — не через код журнала."""
    return set(db.scalars(LIST_PARTITIONS_SQL))


def tables(db: Session) -> set[str]:
    """Имена таблиц по каталогу PostgreSQL."""
    return set(db.scalars(LIST_TABLES_SQL))


def placed_in(db: Session, marker: str) -> str:
    """Имя партиции, в которой физически лежит строка."""
    placed = db.scalar(SELECT_PARTITION_SQL, {"marker": marker})
    assert placed is not None
    return str(placed).split(".")[-1]


@pytest.mark.dbtest
def test_partitions_cover_the_current_and_next_twelve_months() -> None:
    """Запас — год вперёд: месяц без партиции теряет записи журнала."""
    ahead = get_settings().audit_partitions_ahead
    expected = {partition_name(shift_month(current_month(), offset)) for offset in range(ahead + 1)}

    with db_module.SessionLocal() as db:
        assert expected <= partitions(db)
        assert DEFAULT_PARTITION in tables(db)


@pytest.mark.dbtest
def test_ensure_partitions_creates_the_missing_month() -> None:
    """Старт приложения досоздаёт месяц, которого не хватает."""
    month = shift_month(current_month(), get_settings().audit_partitions_ahead)
    name = partition_name(month)

    with db_module.SessionLocal() as db:
        db.execute(text(f'DROP TABLE IF EXISTS "{name}"'))
        db.commit()
        assert name not in partitions(db)

        ensure_partitions(db, get_settings().audit_partitions_ahead)

        assert name in partitions(db)


@pytest.mark.dbtest
def test_ensure_partitions_creates_the_default_partition() -> None:
    """`DEFAULT`-партиция создаётся заново: без неё пропущенный месяц = отказ."""
    with db_module.SessionLocal() as db:
        db.execute(text(f'DROP TABLE IF EXISTS "{DEFAULT_PARTITION}"'))
        db.commit()
        assert DEFAULT_PARTITION not in tables(db)

        ensure_partitions(db, get_settings().audit_partitions_ahead)

        assert DEFAULT_PARTITION in tables(db)


@pytest.mark.dbtest
def test_row_of_the_current_month_lives_in_the_current_partition() -> None:
    """Строка с `created_at` текущего месяца физически лежит в своей партиции."""
    marker = str(uuid4())

    with db_module.SessionLocal() as db:
        db.execute(INSERT_EVENT_SQL, {"marker": marker})
        db.commit()
        try:
            assert placed_in(db, marker) == partition_name(current_month())
        finally:
            db.execute(DELETE_MARKER_SQL, {"marker": marker})
            db.commit()


@pytest.mark.dbtest
def test_row_of_a_missing_month_lives_in_the_default_partition() -> None:
    """Месяца в запасе нет — строка ложится в `DEFAULT`, а не теряется."""
    marker = str(uuid4())
    month = shift_month(current_month(), FAR_FUTURE_MONTHS)
    created_at = datetime(month.year, month.month, 15, 12, 0, tzinfo=UTC)

    with db_module.SessionLocal() as db:
        try:
            assert partition_name(month) not in partitions(db)
            db.execute(INSERT_OLD_EVENT_SQL, {"marker": marker, "created_at": created_at})
            db.commit()

            assert placed_in(db, marker) == DEFAULT_PARTITION
        finally:
            db.execute(DELETE_MARKER_SQL, {"marker": marker})
            db.commit()


@pytest.mark.dbtest
def test_drop_of_a_partition_removes_its_rows() -> None:
    """`DROP` партиции уносит её строки, не трогая остальной журнал."""
    month = shift_month(current_month(), FAR_AHEAD_MONTHS)
    name = partition_name(month)
    marker = str(uuid4())
    created_at = datetime(month.year, month.month, 15, 12, 0, tzinfo=UTC)
    create_partition = text(
        f'CREATE TABLE IF NOT EXISTS "{name}" PARTITION OF audit_events '
        f"FOR VALUES FROM ('{month.isoformat()}') "
        f"TO ('{shift_month(month, 1).isoformat()}')"
    )

    with db_module.SessionLocal() as db:
        try:
            db.execute(create_partition)
            db.execute(INSERT_OLD_EVENT_SQL, {"marker": marker, "created_at": created_at})
            db.commit()
            assert placed_in(db, marker) == name

            db.execute(text(f'DROP TABLE "{name}"'))
            db.commit()

            assert db.scalar(COUNT_MARKER_SQL, {"marker": marker}) == 0
        finally:
            # Партиция уносится в любом случае: после неё в журнале не остаётся
            # строк, а в запасе приложения этого месяца нет.
            db.execute(text(f'DROP TABLE IF EXISTS "{name}"'))
            db.commit()
