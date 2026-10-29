"""Ревизия `0050_public_document_texts`: новые тексты трёх публичных документов.

Проверяется то, что видно без живой базы, и то, что видно только на ней:

* ревизия стоит на текущей голове дерева и не заводит вторую голову;
* `CODES` — ровно три публичных документа, оферты среди них нет, и слова
  `offer` нет ни в одном словаре текстов, ни в самом файле ревизии;
* новые тексты — plain text: абзацы разделены пустой строкой, их не меньше
  восьми, разметки (`<`, `[`, `](`, `**`) нет, пустых абзацев нет;
* в каждом тексте остались обязательные фразы документа и прочерк-заглушка
  реквизитов; заголовки документов ревизия не упоминает вовсе;
* прежние тексты — дословные копии констант `0017_documents` и `0039_consent`;
* на синтетической схеме `upgrade` переписывает ровно три строки и двигает их
  `updated_at`, оставляя оферту нетронутой, а `downgrade` возвращает прежние
  тексты и снова двигает редакцию; отсутствующую строку `upgrade` не создаёт.

Схема собирается по шагам, как на живой базе: сначала настоящие ревизии
`0017_documents` и `0039_consent` заводят таблицу, четыре документа и колонки
согласия, и только на эту готовую схему ложится `0050`. Так тексты приходят к
шагу `0050` в том виде, в каком они лежат в базе, а не в упрощённой копии,
собранной руками.

Прогон идёт на SQLite: настоящая PostgreSQL проверяется на стенде (`alembic
upgrade head`, `alembic downgrade -1` и снова `alembic upgrade head`).
"""

from datetime import datetime
from pathlib import Path
from types import ModuleType
from typing import NamedTuple

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.migration_support import assert_on_previous_head, assert_single_head, load_migration

BACKEND = Path(__file__).resolve().parents[1]
VERSIONS = BACKEND / "alembic" / "versions"
ALEMBIC_DIR = BACKEND / "alembic"
REVISION_PATH = VERSIONS / "0050_public_document_texts.py"

REVISION = "0050_public_document_texts"
PARENT = "0049_solution_journal"

# Оферту ревизия не трогает: её кода нет ни в одном словаре текстов, и самого
# слова нет в файле ревизии — так правку оферты видно в диффе сразу.
OFFER_CODE = "offer"
DOCUMENT_CODES = ("privacy-policy", "terms-of-use", "personal-data-consent")

# Обязательные фразы документа: группы синонимов, в каждой достаточно одной.
REQUIRED_PHRASES: dict[str, tuple[tuple[str, ...], ...]] = {
    "privacy-policy": (
        ("Оператор персональных данных",),
        ("журнал действий",),
        ("cookie",),
        ("IP-адрес",),
    ),
    "personal-data-consent": (
        ("отозвать",),
        ("проживающих",),
        ("редакци",),
    ),
    "terms-of-use": (
        ("Запрещено", "запрещено"),
        ("учётная запись", "Учётная запись"),
    ),
}

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
    """Схема до `0050`: настоящие `0017_documents` и `0039_consent` на пустой базе."""
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
    """Голова на момент работы — `0049_solution_journal`, и она одна."""
    assert_on_previous_head(migration(), REVISION, PARENT)
    assert_single_head(ALEMBIC_DIR)


def test_revision_id_fits_the_version_column() -> None:
    """`alembic_version.version_num` — `varchar(32)`, длинный идентификатор не влезет."""
    revision = migration().revision

    assert revision == REVISION
    assert len(revision) < 32


def test_codes_are_exactly_three_public_documents() -> None:
    assert migration().CODES == DOCUMENT_CODES
    assert len(migration().CODES) == 3


def test_oferta_is_not_mentioned_anywhere() -> None:
    """Оферта не входит ни в новые, ни в прежние тексты, и слова нет в файле.

    Снимок акцепта в счетах — это `updated_at` оферты: любая правка её строки
    разъехалась бы с уже выставленными счетами, поэтому отсутствие кода в файле
    проверяется буквально.
    """
    module = migration()

    assert OFFER_CODE not in module.CODES
    assert OFFER_CODE not in module.NEW_BODIES
    assert OFFER_CODE not in module.OLD_BODIES
    assert OFFER_CODE not in source()


def test_titles_are_not_touched() -> None:
    """Заголовки документов — не предмет ревизии: слова нет ни в запросе, ни в файле."""
    assert "title" not in source()


# --- Новые тексты ------------------------------------------------------------


@pytest.mark.parametrize("code", DOCUMENT_CODES)
def test_new_body_is_plain_text_paragraphs(code: str) -> None:
    """Абзацы разделены пустой строкой, разметки и пустых абзацев нет."""
    body = migration().NEW_BODIES[code]

    paragraphs = body.split("\n\n")
    assert len(paragraphs) >= 8, code
    assert all(paragraph.strip() for paragraph in paragraphs), code
    assert body == body.strip(), code
    assert "<" not in body, code
    assert "[" not in body, code
    assert "](" not in body, code
    assert "**" not in body, code


@pytest.mark.parametrize("code", DOCUMENT_CODES)
def test_new_body_keeps_required_phrases(code: str) -> None:
    """Смысловые опоры документа на месте: их потеря — это другой документ."""
    body = migration().NEW_BODIES[code]

    for alternatives in REQUIRED_PHRASES[code]:
        assert any(phrase in body for phrase in alternatives), (code, alternatives)


@pytest.mark.parametrize("code", DOCUMENT_CODES)
def test_new_body_keeps_placeholder_dash(code: str) -> None:
    """Прочерк — заглушка владельца данных: реквизиты и адрес поддержки не заполнены."""
    assert "—" in migration().NEW_BODIES[code], code


@pytest.mark.parametrize("code", DOCUMENT_CODES)
def test_new_body_differs_from_old(code: str) -> None:
    """Новая редакция — именно новая: тот же текст не менял бы редакцию зря."""
    module = migration()

    assert module.NEW_BODIES[code] != module.OLD_BODIES[code], code


# --- Прежние тексты ----------------------------------------------------------


def test_old_bodies_are_copies_of_the_previous_revisions() -> None:
    """Откат возвращает текст прежней ревизии дословно, а не пересказ."""
    documents = load_migration(VERSIONS / "0017_documents.py")
    consent = load_migration(VERSIONS / "0039_consent.py")
    module = migration()

    assert module.OLD_BODIES["privacy-policy"] == documents.PRIVACY_POLICY_BODY
    assert module.OLD_BODIES["terms-of-use"] == documents.TERMS_OF_USE_BODY
    assert module.OLD_BODIES["personal-data-consent"] == consent.CONSENT_BODY


# --- Ревизия на схеме --------------------------------------------------------


def test_upgrade_rewrites_only_three_documents() -> None:
    """Ровно три строки получают новый текст и новую редакцию; оферта не тронута."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        move_all_to_old_moment(connection)
        module = migration()

        with_operations(module, Operations(MigrationContext.configure(connection))).upgrade()

        current = rows(connection)
        assert set(current) == {*DOCUMENT_CODES, OFFER_CODE}

        for code in DOCUMENT_CODES:
            assert current[code].body == module.NEW_BODIES[code], code
            assert current[code].updated_at > OLD_MOMENT, code

        oferta = load_migration(VERSIONS / "0017_documents.py").OFFER_BODY
        assert current[OFFER_CODE].body == oferta
        assert current[OFFER_CODE].updated_at == OLD_MOMENT
    engine.dispose()


def test_repeated_upgrade_is_harmless() -> None:
    """Повторный `upgrade` после обрыва не портит базу: тот же текст, снова редакция."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        module = migration()
        operations = Operations(MigrationContext.configure(connection))
        with_operations(module, operations)

        module.upgrade()
        module.upgrade()

        current = rows(connection)
        assert set(current) == {*DOCUMENT_CODES, OFFER_CODE}
        for code in DOCUMENT_CODES:
            assert current[code].body == module.NEW_BODIES[code], code
    engine.dispose()


def test_downgrade_returns_previous_texts_and_moves_revision() -> None:
    """Откат возвращает прежний текст и тоже сдвигает `updated_at`: это правка редакции."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        move_all_to_old_moment(connection)
        module = migration()
        with_operations(module, Operations(MigrationContext.configure(connection)))

        module.upgrade()
        after_upgrade = {code: rows(connection)[code].updated_at for code in DOCUMENT_CODES}

        module.downgrade()

        current = rows(connection)
        for code in DOCUMENT_CODES:
            assert current[code].body == module.OLD_BODIES[code], code
            # Секундное разрешение `now()` не даёт строгого неравенства между
            # двумя соседними вызовами, поэтому проверка — «не откатилось назад».
            assert current[code].updated_at >= after_upgrade[code], code
            assert current[code].updated_at > OLD_MOMENT, code
        assert current[OFFER_CODE].updated_at == OLD_MOMENT
    engine.dispose()


def test_upgrade_does_not_create_an_absent_document() -> None:
    """Отсутствующую строку ревизия не заводит: её судьбу решает владелец данных."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        documents = documents_table(connection)
        connection.execute(documents.delete().where(documents.c.code == "personal-data-consent"))

        with_operations(migration(), Operations(MigrationContext.configure(connection))).upgrade()

        current = rows(connection)
        assert set(current) == {"privacy-policy", "terms-of-use", OFFER_CODE}
    engine.dispose()
