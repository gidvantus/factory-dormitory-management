"""Ревизия `0064_mail_hero_house`: домик в плашке-герое писем — вложением с `cid`.

Проверяется то, что ломается тихо:

* ревизия стоит на своде голов (`0063_merge_main_heads`), а свод — на двух прежних
  головах: на двух головах `alembic upgrade head` падает с «Multiple head revisions»,
  и `api` уходит в цикл перезапусков;
* `upgrade` проставляет вёрстку с `src="cid:domovoy-house@domovoy"` ровно строкам
  `invitation` и `activation`, не создаёт отсутствующий код, не трогает
  `password_recovery` и не переписывает `subject`/plain-текст;
* `downgrade` возвращает `body_html` ровно тот, что был в `0059_mail_html_bodies`
  (а не `NULL`): иначе после отката письма уехали бы в старую обёртку;
* у каждого `<img>` в письме источник начинается с `cid:`, а `alt` на месте:
  внешних картинок и `data:`-URI в письмах нет;
* ассет существует, это PNG 224×224 (показ 112×112), и он не пустой: письмо едет
  вложением, а не ссылкой на хостинг.

Стенд прогона ревизий на SQLite (`engine_connection`, `build_mail_templates`,
`insert_template`, `mail_rows`, `run_upgrade`/`run_downgrade`) живёт в
`tests/migration_support.py` один на все файлы тестов ревизий: правка `0011` иначе
попала бы в одну копию, а вторая молча собирала бы прежнюю схему. Настоящий DDL
(`alembic upgrade head`, `downgrade -1`, снова `upgrade`) проверяется на стенде —
SQLite `IF NOT EXISTS` в `ADD COLUMN` не понимает, поэтому здесь DDL идёт через
`sqlite_compatible`.
"""

import struct
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from app import mail as mail_module
from app.mail import (
    HOUSE_IMAGE_CID,
    HOUSE_IMAGE_PATH,
    render_activation_email,
    render_invitation_email,
)
from app.models.mail_template import MailTemplate
from tests.migration_support import (
    assert_no_external_resources,
    assert_on_previous_head,
    assert_single_head,
    build_mail_templates,
    insert_template,
    load_migration,
    mail_rows,
    run_downgrade,
    run_upgrade,
)

VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
ALEMBIC_DIR = VERSIONS.parent
MIGRATION_PATH = VERSIONS / "0064_mail_hero_house.py"
PREVIOUS_PATH = VERSIONS / "0059_mail_html_bodies.py"
MERGE_PATH = VERSIONS / "0063_merge_main_heads.py"
REVISION = "0064_mail_hero_house"
PARENT = "0063_merge_main_heads"
MERGE_REVISION = "0063_merge_main_heads"
MERGE_PARENTS = ("0060_merge_stand_heads", "0062_table_views")

INVITATION_CODE = "invitation"
ACTIVATION_CODE = "activation"
RECOVERY_CODE = "password_recovery"

SUBJECT = "Приглашение в систему «Домовой»"
BODY = "Здравствуйте, {full_name}!\nЗадайте пароль: {activation_url}\n"
RECOVERY_SUBJECT = "Восстановление пароля в системе «Домовой»"
RECOVERY_BODY = "Здравствуйте, {full_name}!\nПароль: {activation_url}\n"

ACTIVATION_SUBJECT = "Активация личного кабинета Домовой"
ACTIVATION_BODY = "Здравствуйте, {full_name}!\nАктивируйте кабинет: {activation_url}\n"

# Целевая ссылка на картинку в письме и подпись, которой домик не должен иметь.
HOUSE_SRC = f'src="cid:{HOUSE_IMAGE_CID}"'
HOUSE_IMAGE_NAME = "house-hero.png"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
HOUSE_IMAGE_SIDE_PX = 224
MIN_HOUSE_IMAGE_BYTES = 3 * 1024
MAX_HOUSE_IMAGE_BYTES = 20 * 1024


def prepared_database(connection: Connection) -> None:
    """База «как после `0059`»: оба письма с прежней вёрсткой, плюс восстановление."""
    build_mail_templates(connection)
    insert_template(connection, code=INVITATION_CODE, subject=SUBJECT, body=BODY)
    insert_template(connection, code=RECOVERY_CODE, subject=RECOVERY_SUBJECT, body=RECOVERY_BODY)
    run_upgrade(connection, PREVIOUS_PATH)


# --- Дерево ревизий ---------------------------------------------------------


def test_revision_sits_on_top_of_the_previous_head() -> None:
    assert_on_previous_head(load_migration(MIGRATION_PATH), REVISION, PARENT)


def test_merge_revision_unites_the_two_previous_heads() -> None:
    """Две головы `develop-m` сводятся одной пустой ревизией, иначе `upgrade head` падает."""
    merge = load_migration(MERGE_PATH)
    assert merge.revision == MERGE_REVISION
    assert tuple(sorted(merge.down_revision)) == tuple(sorted(MERGE_PARENTS))


def test_revision_tree_has_exactly_one_head() -> None:
    assert_single_head(ALEMBIC_DIR)


# --- Данные: домик только у двух писем --------------------------------------


def test_upgrade_gives_the_house_to_the_two_letters(engine_connection: Connection) -> None:
    prepared_database(engine_connection)

    run_upgrade(engine_connection, MIGRATION_PATH)

    rows = mail_rows(engine_connection)
    assert set(rows) == {ACTIVATION_CODE, INVITATION_CODE, RECOVERY_CODE}

    for code in (INVITATION_CODE, ACTIVATION_CODE):
        body_html = rows[code].body_html
        assert body_html is not None
        assert HOUSE_SRC in body_html
        assert 'width="112"' in body_html
        assert 'height="112"' in body_html
        assert 'alt=""' in body_html
        # Остальная вёрстка на месте: подменили только герой.
        assert "Три простых шага — и вы в команде" in body_html

    # Восстановление пароля домика не получает: у него `body_html` остаётся `NULL`.
    assert rows[RECOVERY_CODE].body_html is None

    # `subject` и plain-текст не тронуты: ревизия правит только HTML-часть.
    assert rows[INVITATION_CODE].subject == SUBJECT
    assert rows[INVITATION_CODE].body == BODY
    assert rows[ACTIVATION_CODE].subject == ACTIVATION_SUBJECT
    assert rows[RECOVERY_CODE].body == RECOVERY_BODY


def test_upgrade_does_not_create_a_missing_template(engine_connection: Connection) -> None:
    """Код `invitation` из ревизии `0016` удалён: `upgrade` не вернёт его обратно."""
    prepared_database(engine_connection)
    engine_connection.execute(sa.text("DELETE FROM mail_templates WHERE code = 'invitation'"))

    run_upgrade(engine_connection, MIGRATION_PATH)

    rows = mail_rows(engine_connection)
    assert set(rows) == {ACTIVATION_CODE, RECOVERY_CODE}
    assert HOUSE_SRC in rows[ACTIVATION_CODE].body_html


def test_downgrade_returns_the_layout_of_0059(engine_connection: Connection) -> None:
    """Откат возвращает прежнюю вёрстку, а не `NULL` и не старую обёртку."""
    prepared_database(engine_connection)
    previous = load_migration(PREVIOUS_PATH)

    run_upgrade(engine_connection, MIGRATION_PATH)
    assert HOUSE_SRC in mail_rows(engine_connection)[INVITATION_CODE].body_html

    run_downgrade(engine_connection, MIGRATION_PATH)

    rows = mail_rows(engine_connection)
    assert rows[INVITATION_CODE].body_html == previous.INVITATION_HTML
    assert rows[ACTIVATION_CODE].body_html == previous.ACTIVATION_HTML
    assert HOUSE_SRC not in rows[INVITATION_CODE].body_html
    assert rows[RECOVERY_CODE].body_html is None


# --- Вёрстка письма целиком --------------------------------------------------


def seed_letter(db_session: Session, *, code: str, subject: str, body_html: str) -> None:
    db_session.add(
        MailTemplate(
            code=code,
            subject=subject,
            body=ACTIVATION_BODY,
            body_html=body_html,
            is_active=True,
        )
    )
    db_session.commit()


def test_invitation_html_points_the_hero_at_the_house_attachment(
    db_session: Session,
) -> None:
    migration = load_migration(MIGRATION_PATH)
    seed_letter(
        db_session, code=INVITATION_CODE, subject=SUBJECT, body_html=migration.INVITATION_HTML
    )

    rendered = render_invitation_email(
        db_session,
        full_name="Мария Соколова",
        activation_url="https://domovoy.example/activate/abc",
        organization_name="Ромашка",
    )

    html = rendered.html
    assert html is not None
    assert HOUSE_SRC in html
    assert html.count("<img") == 1
    assert "{" not in html
    assert "Администратор организации «Ромашка» приглашает вас" in html
    assert 'href="https://domovoy.example/activate/abc"' in html
    # Домик — украшение: без картинки письмо читается, поэтому `alt` пустой.
    assert 'alt=""' in html
    assert "background:#dceee4;border-radius:18px" in html
    assert_no_external_resources(html)


def test_activation_html_keeps_only_the_letter_specific_parts(db_session: Session) -> None:
    migration = load_migration(MIGRATION_PATH)
    seed_letter(
        db_session,
        code=ACTIVATION_CODE,
        subject=ACTIVATION_SUBJECT,
        body_html=migration.ACTIVATION_HTML,
    )

    rendered = render_activation_email(
        db_session,
        full_name="Мария Соколова",
        activation_url="https://domovoy.example/activate/abc",
    )

    html = rendered.html
    assert html is not None
    assert "Добро пожаловать в «Домовой»" in html
    assert "Активировать кабинет" in html
    assert HOUSE_SRC in html
    assert_no_external_resources(html)


# --- Ассет ------------------------------------------------------------------


def test_house_image_is_a_png_of_the_expected_size() -> None:
    """Картинка существует, это PNG 224×224 (показ 112×112) и она не пустая."""
    assert HOUSE_IMAGE_PATH.name == HOUSE_IMAGE_NAME
    assert HOUSE_IMAGE_PATH.is_file()

    content = HOUSE_IMAGE_PATH.read_bytes()
    assert content.startswith(PNG_SIGNATURE)
    # Ширина и высота лежат в IHDR сразу после сигнатуры и длины блока.
    width, height = struct.unpack(">II", content[16:24])
    assert (width, height) == (HOUSE_IMAGE_SIDE_PX, HOUSE_IMAGE_SIDE_PX)
    # Плоская двухцветная иконка весит меньше пяти килобайт, поэтому нижняя
    # граница здесь — защита от пустого файла, а не от «слишком лёгкой» картинки:
    # потолок в 20 КБ и есть требование к весу письма.
    assert MIN_HOUSE_IMAGE_BYTES <= len(content) <= MAX_HOUSE_IMAGE_BYTES


def test_house_image_path_points_next_to_the_module() -> None:
    """Файл читается из исходников рядом с модулем, а не из текущего каталога."""
    assert Path(mail_module.__file__).parent / "mail_assets" / HOUSE_IMAGE_NAME == HOUSE_IMAGE_PATH
