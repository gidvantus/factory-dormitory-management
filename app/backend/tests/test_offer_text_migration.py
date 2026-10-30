"""Ревизия `0056_offer_text`: полный текст оферты для организаций.

Проверяется то, что видно без живой базы, и то, что видно только на ней:

* ревизия стоит на текущей голове дерева и не заводит вторую голову;
* новый текст — plain text: абзацы разделены пустой строкой, их не меньше
  двадцати, разметки (`<`, `[`, `](`, `**`) нет, пустых абзацев нет;
* в тексте остались обязательные опоры документа: акцепт, Тариф, Решение,
  пробный период с даты активации, редакция, персональные данные, Счёт и
  прочерк реквизитов;
* `OLD_OFFER_BODY` — дословная копия `OFFER_BODY` из `0017_documents`, иначе
  откат вернёт не тот текст, который лежит в базе;
* собранный `UPDATE` пишет ровно три колонки — `code`, `body`, `updated_at`;
* на синтетической схеме `upgrade` переписывает ровно строку `offer` и двигает
  её `updated_at`, оставляя три остальных документа нетронутыми ни телом, ни
  редакцией, а `downgrade` возвращает прежний текст и снова двигает редакцию;
* отсутствующую строку `offer` ревизия не создаёт.

Схема собирается обвязчиком `tests/migration_support.py`: настоящие ревизии
`0017_documents` и `0039_consent` заводят таблицу, четыре документа и колонки
согласия, и только на эту готовую схему ложится `0056`. Так оферта приходит к
шагу `0056` в том виде, в каком она лежит в базе, а не в упрощённой копии.

Прогон идёт на SQLite: настоящая PostgreSQL проверяется на стенде (`alembic
upgrade head`, `alembic downgrade -1` и снова `alembic upgrade head`).
"""

from datetime import datetime
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.migration_support import (
    assert_on_previous_head,
    assert_single_head,
    build_documents,
    documents_table,
    load_migration,
    move_all_to_old_moment,
    rows,
    with_operations,
)

BACKEND = Path(__file__).resolve().parents[1]
ALEMBIC_DIR = BACKEND / "alembic"
REVISION_PATH = ALEMBIC_DIR / "versions" / "0056_offer_text.py"

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
    # Пробный период начинается активацией учётной записи, а не регистрацией
    # организации: текст обязан называть момент, иначе он описывает другой продукт.
    ("активаци",),
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


def test_query_writes_only_body_and_revision() -> None:
    """`UPDATE` трогает ровно три колонки: заголовка и порядка в нём нет.

    Проверяется собранный запрос, а не исходник ревизии: комментарий про `title`
    в файле не должен ронять тест, а настоящий инвариант — то, что в `sa.table`
    объявлены только `code`, `body` и `updated_at`, и в запрос попадают они же.
    """
    documents = migration().DOCUMENTS
    statement = str(
        documents.update()
        .where(documents.c.code == OFFER_CODE)
        .values(body="текст", updated_at=sa.func.now())
    )

    assert set(documents.c.keys()) == {"code", "body", "updated_at"}
    assert "title" not in statement
    assert "position" not in statement


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
    """Смысловые опоры оферты на месте: их потеря — это другой документ.

    Прочерк реквизитов держится фразой `"инн —"`: отдельный тест на любую «—» в
    тексте падал бы только при удалении всей типографики, а не при заполнении
    реквизитов.
    """
    body = migration().NEW_OFFER_BODY.lower()

    for alternatives in REQUIRED_PHRASES:
        assert any(phrase in body for phrase in alternatives), alternatives


def test_new_body_differs_from_old() -> None:
    """Новая редакция — именно новая: тот же текст не менял бы редакцию зря."""
    module = migration()

    assert module.NEW_OFFER_BODY != module.OLD_OFFER_BODY


# --- Прежний текст -----------------------------------------------------------


def test_old_body_is_a_verbatim_copy_of_the_previous_revision() -> None:
    """Откат возвращает текст `0017_documents` дословно, а не пересказ."""
    documents = load_migration(ALEMBIC_DIR / "versions" / "0017_documents.py")

    assert migration().OLD_OFFER_BODY == documents.OFFER_BODY


# --- Ревизия на схеме --------------------------------------------------------


def test_upgrade_rewrites_only_the_offer() -> None:
    """Строка `offer` получает новый текст и новую редакцию; три других не тронуты."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        move_all_to_old_moment(connection, OLD_MOMENT)
        module = migration()

        with_operations(module, Operations(MigrationContext.configure(connection))).upgrade()

        current = rows(connection)
        assert set(current) == {*OTHER_CODES, OFFER_CODE}

        assert current[OFFER_CODE].body == module.NEW_OFFER_BODY
        assert current[OFFER_CODE].updated_at > OLD_MOMENT

        for code in OTHER_CODES:
            assert current[code].updated_at == OLD_MOMENT, code
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
        move_all_to_old_moment(connection, OLD_MOMENT)
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
