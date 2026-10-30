"""Ревизия `0056_offer_text`: полный текст оферты для организаций.

Проверяется то, что видно без живой базы, и то, что видно только на ней:

* ревизия стоит на текущей голове дерева и не заводит вторую голову;
* новый текст — plain text: абзацы разделены пустой строкой, их не меньше
  двадцати, разметки (`<`, `[`, `](`, `**`) нет, пустых абзацев нет;
* в тексте остались обязательные опоры документа: акцепт, Тариф, Решение,
  пробный период, редакция, персональные данные, Счёт и прочерк реквизитов;
* `OLD_OFFER_BODY` — дословная копия `OFFER_BODY` из `0017_documents`, иначе
  откат вернёт не тот текст, который лежит в базе;
* заголовок документа и его порядок ревизия не упоминает вовсе;
* на синтетической схеме `upgrade` переписывает ровно строку `offer` и двигает
  её `updated_at`, оставляя три остальных документа нетронутыми ни телом, ни
  редакцией, а `downgrade` возвращает прежний текст и снова двигает редакцию;
* отсутствующую строку `offer` ревизия не создаёт.

Схема собирается по шагам, как на живой базе: настоящие ревизии
`0017_documents` и `0039_consent` заводят таблицу, четыре документа и колонки
согласия, и только на эту готовую схему ложится `0056`. Так оферта приходит к
шагу `0056` в том виде, в каком она лежит в базе, а не в упрощённой копии.

Прогон идёт на SQLite: настоящая PostgreSQL проверяется на стенде (`alembic
upgrade head`, `alembic downgrade -1` и снова `alembic upgrade head`).
"""

from datetime import datetime
from pathlib import Path
from types import ModuleType
from typing import NamedTuple

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.migration_support import assert_on_previous_head, assert_single_head, load_migration

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic" / "versions"
ALEMBIC_DIR = BACKEND / "alembic"
REVISION_PATH = VERSIONS / "0056_offer_text.py"

REVISION = "0056_offer_text"
PARENT = "0055_notification_rules"

OFFER_CODE = "offer"
# Три документа, которые ревизия обязана оставить нетронутыми.
OTHER_CODES = ("privacy-policy", "terms-of-use", "personal-data-consent")

# Обязательные фразы оферты: группы синонимов, в каждой достаточно одной.
# Сравнение идёт по тексту в нижнем регистре, поэтому регистр первой буквы
# пункта значения не имеет.
REQUIRED_PHRASES: tuple[tuple[str, ...], ...] = (
    ("акцепт",),
    ("тариф",),
    ("решение",),
    ("пробн",),
    ("редакци",),
    ("персональн",),
    ("счёт", "счет"),
    ("инн —",),
)

# Момент до ревизии: `updated_at` после `upgrade` обязан быть позже него, иначе
# ревизия переписала бы текст, не сдвинув редакцию.
OLD_MOMENT = datetime(2020, 1, 1, 12, 0)


def migration() -> ModuleType:
    return load_migration(REVISION_PATH)


def source() -> str:
    return REVISION_PATH.read_text(encoding="utf-8")


def with_operations(module: ModuleType, operations: Operations) -> ModuleType:
    """Подставить ревизии рабочий `op` — так же, как это делает Alembic.

    `setattr`, а не `module.op = operations`: у `ModuleType` объявленного атрибута
    `op` нет, и присваивание добавило бы ошибку типизатора.
    """
    setattr(module, "op", operations)  # noqa: B010 - см. докстринг: так требует mypy
    return module


def build_documents(connection: sa.Connection) -> None:
    """Схема до `0056`: настоящие `0017_documents` и `0039_consent` на пустой базе."""
    metadata = sa.MetaData()
    sa.Table("users", metadata, sa.Column("id", sa.Integer(), primary_key=True))
    metadata.create_all(connection)

    operations = Operations(MigrationContext.configure(connection))
    for filename in ("0017_documents.py", "0039_consent.py"):
        with_operations(load_migration(VERSIONS / filename), operations).upgrade()


def documents_table(connection: sa.Connection) -> sa.Table:
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


def move_all_to_old_moment(connection: sa.Connection) -> None:
    """Все строки получают давнюю редакцию: тогда сдвиг `updated_at` виден."""
    documents = documents_table(connection)
    connection.execute(documents.update().values(updated_at=OLD_MOMENT))


# --- Метаданные ревизии ------------------------------------------------------


def test_revision_stands_on_the_single_current_head() -> None:
    """Голова на момент работы — `0055_notification_rules`, и она одна."""
    assert_on_previous_head(migration(), REVISION, PARENT)
    assert_single_head(ALEMBIC_DIR)


def test_revision_id_fits_the_version_column() -> None:
    """`alembic_version.version_num` — `varchar(32)`, длинный идентификатор не влезет."""
    revision = migration().revision

    assert revision == REVISION
    assert len(revision) < 32


def test_revision_rewrites_one_code_only() -> None:
    """Пишется ровно один документ, и это оферта."""
    assert migration().OFFER_CODE == OFFER_CODE
    assert OFFER_CODE in source()


def test_title_and_position_are_not_touched() -> None:
    """Заголовок и порядок документа — не предмет ревизии: слов нет ни в файле, ни в запросе."""
    text = source()

    assert "title" not in text
    assert "position" not in text


# --- Новый текст -------------------------------------------------------------


def test_new_body_is_plain_text_paragraphs() -> None:
    """Абзацы разделены пустой строкой, разметки и пустых абзацев нет."""
    body = migration().NEW_OFFER_BODY

    paragraphs = body.split("\n\n")
    assert len(paragraphs) >= 20
    assert all(paragraph.strip() for paragraph in paragraphs)
    assert body == body.strip()
    assert "<" not in body
    assert "[" not in body
    assert "](" not in body
    assert "**" not in body


def test_new_body_keeps_required_phrases() -> None:
    """Смысловые опоры оферты на месте: их потеря — это другой документ."""
    body = migration().NEW_OFFER_BODY.lower()

    for alternatives in REQUIRED_PHRASES:
        assert any(phrase in body for phrase in alternatives), alternatives


def test_new_body_keeps_placeholder_dash() -> None:
    """Прочерк — заглушка реквизитов Продавца: реальные значения вписывает человек."""
    assert "—" in migration().NEW_OFFER_BODY


def test_new_body_differs_from_old() -> None:
    """Новая редакция — именно новая: тот же текст не менял бы редакцию зря."""
    module = migration()

    assert module.NEW_OFFER_BODY != module.OLD_OFFER_BODY


# --- Прежний текст -----------------------------------------------------------


def test_old_body_is_a_verbatim_copy_of_the_previous_revision() -> None:
    """Откат возвращает текст `0017_documents` дословно, а не пересказ."""
    documents = load_migration(VERSIONS / "0017_documents.py")

    assert migration().OLD_OFFER_BODY == documents.OFFER_BODY


# --- Ревизия на схеме --------------------------------------------------------


def test_upgrade_rewrites_only_the_offer() -> None:
    """Строка `offer` получает новый текст и новую редакцию; три других не тронуты."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        move_all_to_old_moment(connection)
        module = migration()

        with_operations(module, Operations(MigrationContext.configure(connection))).upgrade()

        current = rows(connection)
        assert set(current) == {*OTHER_CODES, OFFER_CODE}

        assert current[OFFER_CODE].body == module.NEW_OFFER_BODY
        assert current[OFFER_CODE].updated_at > OLD_MOMENT

        previous = rows(connection)
        for code in OTHER_CODES:
            assert previous[code].updated_at == OLD_MOMENT, code
    engine.dispose()


def test_upgrade_does_not_touch_other_bodies() -> None:
    """Тексты политики, правил и согласия ревизия не переписывает."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        before = {code: rows(connection)[code].body for code in OTHER_CODES}

        with_operations(migration(), Operations(MigrationContext.configure(connection))).upgrade()

        after = rows(connection)
        for code in OTHER_CODES:
            assert after[code].body == before[code], code
    engine.dispose()


def test_repeated_upgrade_is_harmless() -> None:
    """Повторный `upgrade` после обрыва не портит базу: тот же текст, снова редакция."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        module = migration()
        with_operations(module, Operations(MigrationContext.configure(connection)))

        module.upgrade()
        module.upgrade()

        current = rows(connection)
        assert set(current) == {*OTHER_CODES, OFFER_CODE}
        assert current[OFFER_CODE].body == module.NEW_OFFER_BODY
    engine.dispose()


def test_downgrade_returns_previous_text_and_moves_revision() -> None:
    """Откат возвращает прежний текст и тоже сдвигает `updated_at`: это правка редакции."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        move_all_to_old_moment(connection)
        module = migration()
        with_operations(module, Operations(MigrationContext.configure(connection)))

        module.upgrade()
        after_upgrade = rows(connection)[OFFER_CODE].updated_at

        module.downgrade()

        current = rows(connection)
        assert current[OFFER_CODE].body == module.OLD_OFFER_BODY
        # Секундное разрешение `now()` не даёт строгого неравенства между двумя
        # соседними вызовами, поэтому проверка — «не откатилось назад».
        assert current[OFFER_CODE].updated_at >= after_upgrade
        assert current[OFFER_CODE].updated_at > OLD_MOMENT
    engine.dispose()


def test_upgrade_does_not_create_an_absent_document() -> None:
    """Отсутствующую строку ревизия не заводит: её судьбу решает владелец данных."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        documents = documents_table(connection)
        connection.execute(documents.delete().where(documents.c.code == OFFER_CODE))

        with_operations(migration(), Operations(MigrationContext.configure(connection))).upgrade()

        current = rows(connection)
        assert set(current) == set(OTHER_CODES)
    engine.dispose()
