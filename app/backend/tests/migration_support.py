"""Общий обвязчик тестов ревизий: разбор DDL, сверка с моделью и `documents`.

Тесты миграций в проекте устроены одинаково: модуль ревизии читается по пути
(каталог `alembic/versions` — не пакет, и импорт по имени разрешился бы в
библиотеку из site-packages), из него достаются `ADD_COLUMNS_SQL` и
`DROP_COLUMNS_SQL`, имена и типы колонок сверяются с моделью SQLAlchemy, а дерево
ревизий проверяется на одну голову.

Ревизии, которые меняют не схему, а данные таблицы `documents`, собирают эту
таблицу сами: `build_documents()` прогоняет настоящие `0017_documents` и
`0039_consent` на пустой SQLite-базе, а `rows()`, `documents_table()` и
`move_all_to_old_moment()` дают тесту строки документов в одном и том же виде.
Пока таких ревизий две (`0050` и `0056`), и обвязчик документов живёт здесь по
той же причине, что и DDL-ный: правка `rows()` (новая колонка, разбор naive-дат
SQLite) иначе попала бы в один файл, а второй молча проверял бы ревизию прежней
обвязкой.

Пока файлов было два, каждый держал свою копию обвязчика — и любая правка
(новая форма DDL, ещё один тип колонки, другой способ проверки головы) должна
была попасть в каждую копию, иначе один из тестов молча проверял бы не то. Яркий
след копирования — расширение проверки типов ветвью `INTEGER` в одном файле и
`==` вместо сравнения префикса в другом. Поэтому обвязчик живёт здесь один:
файлы ревизий объявляют путь, `REVISION`, `PARENT`, модель и префикс колонок, а
своими держат только тесты, специфичные для своей ревизии.

Проверки DDL на настоящей PostgreSQL этими тестами не покрываются: `IF NOT
EXISTS` у `ADD COLUMN` и добавление `REFERENCES` к существующей таблице понимает
PostgreSQL, а не SQLite. Это делается на стенде командами `alembic upgrade head`,
`alembic downgrade -1` и снова `alembic upgrade head`.
"""

import re
from datetime import datetime
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Any, NamedTuple

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory

from app.models.base import Base

ADD_PATTERN = re.compile(r"ADD COLUMN IF NOT EXISTS (\w+) (.+)$")
DROP_PATTERN = re.compile(r"DROP COLUMN IF EXISTS (\w+)$")

# Каталог ревизий: `alembic/versions` рядом с каталогом `tests`, где лежит этот файл.
VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"


def load_migration(path: Path) -> ModuleType:
    """Прочитать модуль ревизии по пути, а не импортом: `alembic/versions` — не пакет."""
    spec = spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    migration: ModuleType = module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def normalized(statement: str) -> str:
    """Схлопнуть переносы в DDL: константа склеена из нескольких строк."""
    return " ".join(statement.split())


def added_columns(migration: ModuleType) -> dict[str, str]:
    """Колонки `upgrade`: имя → объявленный тип с хвостом ограничений.

    Хвост остаётся: у `offer_accepted_by` в том же `ADD COLUMN` объявлен внешний
    ключ, и сравнение типов идёт по префиксу (`type_matches`), а не на равенство.
    """
    parsed: dict[str, str] = {}
    for statement in migration.ADD_COLUMNS_SQL:
        match = ADD_PATTERN.search(normalized(statement))
        assert match is not None, statement
        parsed[match.group(1)] = match.group(2)
    return parsed


def dropped_columns(migration: ModuleType) -> list[str]:
    """Колонки `downgrade` в том порядке, в котором их снимают."""
    names: list[str] = []
    for statement in migration.DROP_COLUMNS_SQL:
        match = DROP_PATTERN.search(normalized(statement))
        assert match is not None, statement
        names.append(match.group(1))
    return names


def model_columns(model: type[Base], prefix: str) -> dict[str, Any]:
    """Колонки модели, которые заводит ревизия: отобраны по префиксу имён."""
    return {
        name: column for name, column in model.__table__.columns.items() if name.startswith(prefix)
    }


def column_type_sql(column: Any) -> str:
    """Ожидаемый DDL-тип колонки: `VARCHAR(n)` / `TIMESTAMP WITH TIME ZONE` / `INTEGER`.

    Незнакомый тип — падение, а не «тест пропустил»: иначе новая колонка другого
    типа прошла бы проверку молча.
    """
    if isinstance(column.type, sa.String):
        return f"VARCHAR({column.type.length})"
    if isinstance(column.type, sa.DateTime):
        # Момент в проекте всегда с часовым поясом: naive-дата ломает сравнение.
        assert column.type.timezone is True, f"{column.name}: момент без часового пояса"
        return "TIMESTAMP WITH TIME ZONE"
    if isinstance(column.type, sa.Integer):
        return "INTEGER"
    raise AssertionError(f"{column.name}: незнакомый тип {column.type!r} — расширьте обвязчик")


def type_matches(column: Any, declared: str) -> bool:
    """Тип из DDL начинается с типа модели; хвост — объявленные ограничения."""
    return declared.upper().startswith(column_type_sql(column))


def assert_on_previous_head(migration: ModuleType, revision: str, parent: str) -> None:
    """Ревизия стоит на ожидаемой голове — той, что была при её написании."""
    assert migration.revision == revision
    assert migration.down_revision == parent


def assert_single_head(alembic_dir: Path) -> None:
    """Вторая голова означает `alembic upgrade head` с «Multiple head revisions».

    Принимает каталог `alembic` — тот, что содержит `versions/` и указан в
    `alembic.ini` как `script_location`; на каталоге `versions` `get_heads()`
    вернул бы пустой список, и тест падал бы всегда, а не проверял головы.
    """
    scripts = ScriptDirectory(str(alembic_dir))
    assert len(scripts.get_heads()) == 1


def assert_columns_match_model(migration: ModuleType, model: type[Base], prefix: str) -> None:
    """Множества имён совпадают: колонка модели без DDL — `UndefinedColumn` в работе."""
    assert set(added_columns(migration)) == set(model_columns(model, prefix))


def assert_nullable_without_default(migration: ModuleType, model: type[Base], prefix: str) -> None:
    """Колонки nullable и без `DEFAULT`: backfill нет, прежние строки остаются `NULL`."""
    for name, column in model_columns(model, prefix).items():
        assert column.nullable is True, name
    for statement in migration.ADD_COLUMNS_SQL:
        sql = normalized(statement).upper()
        assert "NOT NULL" not in sql
        assert "DEFAULT" not in sql


def assert_downgrade_removes_only_added(migration: ModuleType) -> None:
    """Забытая в `downgrade` колонка делает ревизию необратимой."""
    assert sorted(dropped_columns(migration)) == sorted(added_columns(migration))


# --- Ревизии данных таблицы `documents` --------------------------------------


def with_operations(module: ModuleType, operations: Operations) -> ModuleType:
    """Подставить ревизии рабочий `op` — так же, как это делает Alembic.

    `setattr`, а не `module.op = operations`: у `ModuleType` объявленного атрибута
    `op` нет, и присваивание добавило бы ошибку типизатора.
    """
    setattr(module, "op", operations)  # noqa: B010 - см. докстринг: так требует mypy
    return module


def revision_source(path: Path) -> str:
    """Исходник ревизии: тесты ищут в нём слова, которых в запросе быть не должно."""
    return path.read_text(encoding="utf-8")


def build_documents(connection: sa.Connection) -> None:
    """Схема публичных документов: настоящие `0017_documents` и `0039_consent`.

    Таблица, четыре документа и колонки согласия заводятся теми же ревизиями, что
    и в базе, поэтому тексты приходят к проверяемому шагу в том виде, в каком они
    лежат на живой базе, а не в упрощённой копии, собранной руками.
    """
    metadata = sa.MetaData()
    sa.Table("users", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    metadata.create_all(connection)

    operations = Operations(MigrationContext.configure(connection))
    for filename in ("0017_documents.py", "0039_consent.py"):
        with_operations(load_migration(VERSIONS / filename), operations).upgrade()


def documents_table(connection: sa.Connection) -> sa.Table:
    """Таблица `documents` как она есть в базе после `build_documents()`."""
    return sa.Table("documents", sa.MetaData(), autoload_with=connection)


class DocumentRow(NamedTuple):
    """Строка `documents` в том виде, в каком её проверяет тест."""

    code: str
    body: str
    updated_at: datetime


def rows(connection: sa.Connection) -> dict[str, DocumentRow]:
    """Документы по коду: тело и редакция, без прочих колонок.

    Кортеж, а не словарь: `updated_at` нужен типизированным `datetime`, иначе
    сравнение редакций не проходит проверку типов.
    """
    documents = documents_table(connection)
    result = connection.execute(sa.select(documents)).mappings()
    return {
        str(row["code"]): DocumentRow(
            code=str(row["code"]), body=str(row["body"]), updated_at=row["updated_at"]
        )
        for row in result
    }


def move_all_to_old_moment(connection: sa.Connection, moment: datetime) -> None:
    """Все строки получают давнюю редакцию: тогда сдвиг `updated_at` виден."""
    documents = documents_table(connection)
    connection.execute(documents.update().values(updated_at=moment))
