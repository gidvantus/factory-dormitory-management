"""Ревизия `0079_metrika_consent_texts`: Метрика в политике и в согласии.

Проверяется то, что видно без живой базы, и то, что видно только на ней:

* ревизия стоит на голове дерева, на которой её писали, и не заводит вторую
  голову; идентификатор короче 32 символов (`alembic_version.version_num`);
* `CODES` — ровно три публичных документа, оферты среди них нет, и слова
  `offer` нет ни в одном словаре текстов, ни в самом файле ревизии;
* новые тексты — plain text: абзацы разделены пустой строкой, их не меньше
  восьми, разметки (`<`, `[`, `](`, `**`) нет, пустых абзацев нет;
* в политике Метрика описана как обработчик статистики: имя, домен счётчика,
  номер, имена аналитических cookie, загрузка только после согласия и отзыв
  согласия; прежняя фраза «Cookie для рекламы и аналитики Сервис не использует»
  из новой редакции исчезла, а в прежней — была;
* в согласии на обработку данных пункт 2.4 дополнен аналитическими cookie;
* текст правил использования не меняется: новая редакция совпадает с прежней
  дословно, ревизия двигает только отметку редакции;
* прежние тексты — дословные копии `NEW_BODIES` ревизии `0050`;
* на синтетической схеме `upgrade` переписывает ровно три строки и двигает их
  `updated_at`, оставляя оферту нетронутой, а `downgrade` возвращает прежние
  тексты и снова двигает редакцию; отсутствующую строку `upgrade` не создаёт.

Схема собирается по шагам, как на живой базе: сначала настоящие ревизии
`0017_documents` и `0039_consent` заводят таблицу, четыре документа и колонки
согласия, и только на эту готовую схему ложится `0079`. Так тексты приходят к
проверяемому шагу в том виде, в каком они лежат в базе, а не в упрощённой
копии, собранной руками.

Прогон идёт на SQLite: настоящая PostgreSQL проверяется на стенде (`alembic
upgrade head`, `alembic downgrade -1` и снова `alembic upgrade head`).
"""

from datetime import datetime
from types import ModuleType

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.migration_support import (
    VERSIONS,
    assert_on_previous_head,
    assert_single_head,
    build_documents,
    documents_table,
    load_migration,
    move_all_to_old_moment,
    revision_source,
    rows,
    with_operations,
)

ALEMBIC_DIR = VERSIONS.parent
REVISION_PATH = VERSIONS / "0079_metrika_consent_texts.py"

REVISION = "0079_metrika_consent_texts"
# Голова на момент работы: номер и родитель из постановки (#225) устарели —
# пока задача ждала разработки, в `develop-m` пришли `0077_hostel_builder` и
# `0078_hostel_resident_filters`, и идентификатор `0077` занят.
PARENT = "0078_hostel_resident_filters"

# Оферту ревизия не трогает: её кода нет ни в одном словаре текстов, и самого
# слова нет в файле ревизии — так правку оферты видно в диффе сразу.
OFFER_CODE = "offer"
DOCUMENT_CODES = ("privacy-policy", "terms-of-use", "personal-data-consent")

# Документы, текст которых ревизия действительно меняет. Правила использования
# остаются прежними по содержанию: меняется только отметка редакции.
CHANGED_CODES = ("privacy-policy", "personal-data-consent")

# Счётчик Метрики и его cookie — из постановки #225.
METRIKA_COUNTER_ID = "114310629"
METRIKA_COOKIES = ("_ym_uid", "_ym_d", "_ym_isad", "_ym_visorc*")

# Фраза прежней редакции, прямо противоречившая коду: счётчик на сайте есть.
OUTDATED_PHRASE = "Cookie для рекламы и аналитики Сервис не использует"

# Обязательные фразы документа: группы синонимов, в каждой достаточно одной.
REQUIRED_PHRASES: dict[str, tuple[tuple[str, ...], ...]] = {
    "privacy-policy": (
        ("Оператор персональных данных",),
        ("журнал действий",),
        ("cookie",),
        ("IP-адрес",),
        ("Яндекс.Метрика",),
        ("mc.yandex.ru",),
        ("согласи",),
        ("отзыв",),
    ),
    "personal-data-consent": (
        ("отозвать",),
        ("проживающих",),
        ("редакци",),
        ("Яндекс.Метрик",),
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
    return revision_source(REVISION_PATH)


# --- Метаданные ревизии ------------------------------------------------------


def test_revision_stands_on_the_single_current_head() -> None:
    """Голова на момент работы — `0078_hostel_resident_filters`, и она одна."""
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


@pytest.mark.parametrize("code", CHANGED_CODES)
def test_new_body_differs_from_old(code: str) -> None:
    """Новая редакция — именно новая: тот же текст не менял бы редакцию зря."""
    module = migration()

    assert module.NEW_BODIES[code] != module.OLD_BODIES[code], code


# --- Метрика в текстах -------------------------------------------------------


def test_policy_describes_metrika_as_statistics_processor() -> None:
    """Политика называет Метрику, её домен, номер счётчика и его cookie."""
    module = migration()
    body = module.NEW_BODIES["privacy-policy"]

    assert module.METRIKA_COUNTER_ID == METRIKA_COUNTER_ID
    assert METRIKA_COUNTER_ID in body
    assert "Яндекс.Метрика" in body
    assert "mc.yandex.ru" in body
    for cookie in METRIKA_COOKIES:
        assert cookie in body, cookie
    # Загрузка счётчика привязана к согласию, а не к факту визита.
    assert "только после того, как посетитель нажал «Принять»" in body


def test_policy_no_longer_claims_no_analytics_cookies() -> None:
    """Противоречие с кодом снято: прежняя фраза была, в новой редакции её нет."""
    module = migration()
    new_body = module.NEW_BODIES["privacy-policy"]
    old_body = module.OLD_BODIES["privacy-policy"]

    assert OUTDATED_PHRASE in old_body
    assert OUTDATED_PHRASE not in new_body
    # Аналитические cookie теперь описаны как используемые — и только по согласию.
    assert "аналитические cookie" in new_body


def test_consent_mentions_analytics_cookies() -> None:
    """Пункт 2.4 согласия дополнен аналитическими cookie Метрики."""
    module = migration()
    body = module.NEW_BODIES["personal-data-consent"]

    for cookie in METRIKA_COOKIES:
        assert cookie in body, cookie
    assert "Яндекс.Метрик" in body
    assert "До согласия счётчик Метрики не загружается" in body


def test_terms_of_use_text_is_unchanged() -> None:
    """Условия работы в системе от Метрики не зависят: правится только редакция."""
    module = migration()

    assert module.NEW_BODIES["terms-of-use"] == module.OLD_BODIES["terms-of-use"]


# --- Прежние тексты ----------------------------------------------------------


def test_old_bodies_are_copies_of_the_previous_revision() -> None:
    """Откат возвращает текст прежней ревизии дословно, а не пересказ."""
    previous = load_migration(VERSIONS / "0050_public_document_texts.py")

    assert migration().OLD_BODIES == previous.NEW_BODIES


# --- Ревизия на схеме --------------------------------------------------------


def test_upgrade_rewrites_only_three_documents() -> None:
    """Ровно три строки получают новую редакцию; оферта не тронута."""
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        build_documents(connection)
        move_all_to_old_moment(connection, OLD_MOMENT)
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
        with_operations(module, Operations(MigrationContext.configure(connection)))

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
        move_all_to_old_moment(connection, OLD_MOMENT)
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
