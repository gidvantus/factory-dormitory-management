"""Миграция 0080: колонка порядка заполняется по ФИО и снимается откатом.

`employees.sort_name` — то же нормализованное ФИО, что считает клиент, поэтому
проверка сверяет заполненные значения с `normalized_name` из модели, а не с
ожидаемыми строками «на глаз». Отдельно проверяется карточка без своего ФИО:
показываемое имя приходит из присоединённой карточки, и в колонку оно тоже
обязано попасть — иначе человек встал бы в начало списка пустой строкой.
"""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from app.models.personnel import normalized_name


def load_migration() -> ModuleType:
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0080_personnel_sort_name.py"
    spec = spec_from_file_location("personnel_sort_name_migration", path)
    assert spec and spec.loader
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_sort_name_is_filled_for_existing_cards_and_removed_by_downgrade() -> None:
    migration = load_migration()
    # Правило нормализации у миграции своё (она не зависит от кода приложения),
    # и оно обязано совпадать с моделью.
    for value in ("  Ёлкин   Пётр ", "Абрамов Иван", "", None):
        assert migration.normalized_name(value) == normalized_name(value)

    engine = sa.create_engine("sqlite://")
    metadata = sa.MetaData()
    employees = sa.Table(
        "employees",
        metadata,
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("full_name", sa.String(255)),
        sa.Column("merged_into_id", sa.String()),
    )
    # Ключи у всех строк одинаковые: `executemany` берёт набор колонок из первой
    # строки, и пропущенный ключ стал бы NULL вместо значения.
    rows: list[dict[str, str | None]] = [
        {"id": "a-root", "full_name": "  Ёлкин   Пётр ", "merged_into_id": None},
        {"id": "b-solo", "full_name": "Абрамов Иван", "merged_into_id": None},
        # Корень без своего ФИО: показываемое имя приходит от участника группы.
        {"id": "c-root", "full_name": None, "merged_into_id": None},
        {"id": "d-member", "full_name": "Яблоков Пётр", "merged_into_id": "c-root"},
        # У корня своё имя: имя участника порядок не задаёт.
        {"id": "e-own", "full_name": "Сидоров Иван", "merged_into_id": None},
        {"id": "f-member", "full_name": "Петров Олег", "merged_into_id": "e-own"},
        {"id": "g-empty", "full_name": "", "merged_into_id": None},
    ]
    with engine.begin() as connection:
        metadata.create_all(connection)
        connection.execute(employees.insert(), rows)
        migration.__dict__["op"] = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        table = sa.Table("employees", sa.MetaData(), autoload_with=connection)
        values = dict(connection.execute(sa.select(table.c.id, table.c.sort_name)).all())
        assert values == {
            "a-root": "елкин петр",
            "b-solo": "абрамов иван",
            "c-root": "яблоков петр",
            "d-member": "яблоков петр",
            "e-own": "сидоров иван",
            "f-member": "петров олег",
            "g-empty": "",
        }
        indexes = {index["name"] for index in sa.inspect(connection).get_indexes("employees")}
        assert migration.INDEX_NAME in indexes

        migration.downgrade()
        columns = {column["name"] for column in sa.inspect(connection).get_columns("employees")}
        assert "sort_name" not in columns
        # Откат трогает только схему: карточки остаются на месте.
        assert list(connection.execute(sa.select(employees.c.id).order_by(employees.c.id)))[0] == (
            "a-root",
        )
    engine.dispose()
