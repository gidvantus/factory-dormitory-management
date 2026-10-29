"""Ревизия `0054_invoice_file_keys`: ключи печатных форм счёта и акта.

Ревизия добавляет две nullable-колонки в две таблицы:
`invoices.invoice_file_key` и `invoice_documents.file_key`. Проверяются три
вещи, которые ломаются тихо:

* ревизия стоит на голове дерева (`0053_uploaded_files`) и голова одна: вторая
  голова валит `alembic upgrade head` с «Multiple head revisions»;
* набор и типы колонок в `ADD_COLUMNS_SQL` совпадают с моделями `Invoice` и
  `InvoiceDocument` — расхождение всплывает только на живой базе как
  `UndefinedColumn`;
* обе колонки nullable и без `DEFAULT` (бэкфилла нет: у исторических счетов
  файла нет), а `downgrade` снимает ровно их — иначе ревизия необратима.

Отдельный `dbtest` доводит проверку до настоящей PostgreSQL: `ADD COLUMN
IF NOT EXISTS` и `DROP COLUMN IF EXISTS` понимает PostgreSQL, а не SQLite. Там
же проверяется главное обещание отката — строки `invoices` и
`invoice_documents` переживают `downgrade` и повторный `upgrade`.
"""

import re
from pathlib import Path
from types import ModuleType

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import db as db_module
from app.models.invoice import Invoice, InvoiceDocument
from tests.migration_support import (
    assert_downgrade_removes_only_added,
    assert_nullable_without_default,
    assert_on_previous_head,
    assert_single_head,
    column_type_sql,
    load_migration,
    model_columns,
    normalized,
    type_matches,
)

ALEMBIC_DIR = Path(__file__).resolve().parents[1] / "alembic"
MIGRATION_PATH = ALEMBIC_DIR / "versions" / "0054_invoice_file_keys.py"
REVISION = "0054_invoice_file_keys"
PARENT = "0053_uploaded_files"

# Таблица → префикс колонок, которые заводит ревизия. Префиксы разные, потому что
# колонки живут в двух таблицах и общий обвязчик (`tests/migration_support.py`)
# различает их именно по префиксу имени.
COLUMNS_BY_TABLE = {"invoices": "invoice_file_", "invoice_documents": "file_"}

MODEL_BY_TABLE = {"invoices": Invoice, "invoice_documents": InvoiceDocument}

# Разбор `ALTER TABLE <таблица> ADD COLUMN IF NOT EXISTS <имя> <тип>`: таблица в
# этом DDL обязательна — колонки две, и общая функция `added_columns` вернула бы
# их одним словарём без указания, к какой таблице каждая относится.
ADD_TABLE_PATTERN = re.compile(
    r"ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) (.+)$", re.IGNORECASE
)


def migration() -> ModuleType:
    return load_migration(MIGRATION_PATH)


def columns_of(module: ModuleType, table: str) -> dict[str, str]:
    """Колонки `upgrade` для одной таблицы: имя → объявленный тип с хвостом."""
    parsed: dict[str, str] = {}
    for statement in module.ADD_COLUMNS_SQL:
        match = ADD_TABLE_PATTERN.search(normalized(statement))
        assert match is not None, statement
        if match.group(1).lower() == table:
            parsed[match.group(2)] = match.group(3)
    return parsed


def test_migration_sits_on_top_of_the_previous_head() -> None:
    assert_on_previous_head(migration(), REVISION, PARENT)


def test_revision_tree_has_exactly_one_head() -> None:
    assert_single_head(ALEMBIC_DIR)


@pytest.mark.parametrize("table", sorted(COLUMNS_BY_TABLE))
def test_it_adds_exactly_the_model_columns(table: str) -> None:
    """Колонка модели без DDL — `UndefinedColumn` в работе, и наоборот."""
    model = model_columns(MODEL_BY_TABLE[table], COLUMNS_BY_TABLE[table])
    assert set(columns_of(migration(), table)) == set(model)
    assert model, f"{table}: ревизия не добавляет ни одной колонки"


@pytest.mark.parametrize("table", sorted(COLUMNS_BY_TABLE))
def test_the_column_type_matches_the_model(table: str) -> None:
    model = model_columns(MODEL_BY_TABLE[table], COLUMNS_BY_TABLE[table])
    for name, declared in columns_of(migration(), table).items():
        assert type_matches(model[name], declared), name
        assert column_type_sql(model[name]) == "VARCHAR(500)", name


def test_the_columns_stay_nullable_and_no_default_is_set() -> None:
    """Бэкфилла нет: у исторических счетов файла нет, `NULL` — верное состояние."""
    module = migration()
    assert_nullable_without_default(module, Invoice, COLUMNS_BY_TABLE["invoices"])
    assert_nullable_without_default(module, InvoiceDocument, COLUMNS_BY_TABLE["invoice_documents"])


def test_downgrade_removes_exactly_what_upgrade_added() -> None:
    assert_downgrade_removes_only_added(migration())


# --- Против настоящей PostgreSQL ----------------------------------------------

SELECT_COLUMNS_SQL = text(
    """
    SELECT table_name, column_name, data_type, character_maximum_length, is_nullable
    FROM information_schema.columns
    WHERE table_name IN ('invoices', 'invoice_documents')
      AND column_name IN ('invoice_file_key', 'file_key')
    """
)
COUNT_INVOICES_SQL = text("SELECT count(*) FROM invoices")
COUNT_DOCUMENTS_SQL = text("SELECT count(*) FROM invoice_documents")


def column_state(db: Session) -> dict[str, tuple[str, int | None, str]]:
    """Колонки ревизии в живой базе: `таблица.колонка` → тип, длина, nullable."""
    return {
        f"{row.table_name}.{row.column_name}": (
            row.data_type,
            row.character_maximum_length,
            row.is_nullable,
        )
        for row in db.execute(SELECT_COLUMNS_SQL)
    }


@pytest.mark.dbtest
def test_upgrade_downgrade_upgrade_keeps_the_rows() -> None:
    """`upgrade → downgrade → upgrade` на настоящей PostgreSQL не теряет строк.

    DDL берётся из модуля ревизии, а не переписывается здесь: переписанное
    правило разошлось бы с миграцией. `IF NOT EXISTS` делает повторный `upgrade`
    безопасным, поэтому тест не зависит от того, на какой ревизии стоит стенд.
    """
    module = migration()
    expected = {
        "invoices.invoice_file_key": ("character varying", 500, "YES"),
        "invoice_documents.file_key": ("character varying", 500, "YES"),
    }

    with db_module.SessionLocal() as db:
        invoices_before = db.scalar(COUNT_INVOICES_SQL)
        documents_before = db.scalar(COUNT_DOCUMENTS_SQL)

        for statement in module.ADD_COLUMNS_SQL:
            db.execute(text(statement))
        assert column_state(db) == expected

        for statement in module.DROP_COLUMNS_SQL:
            db.execute(text(statement))
        assert column_state(db) == {}
        # Откат схемы не трогает данные: строки счетов и актов на месте.
        assert db.scalar(COUNT_INVOICES_SQL) == invoices_before
        assert db.scalar(COUNT_DOCUMENTS_SQL) == documents_before

        for statement in module.ADD_COLUMNS_SQL:
            db.execute(text(statement))
        assert column_state(db) == expected
        assert db.scalar(COUNT_INVOICES_SQL) == invoices_before
        assert db.scalar(COUNT_DOCUMENTS_SQL) == documents_before
        db.commit()
