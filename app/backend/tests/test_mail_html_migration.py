"""Ревизия `0059_mail_html_bodies`: колонка `mail_templates.body_html` и вёрстка писем.

Проверяется то, что ломается тихо:

* ревизия стоит на голове дерева (`0058_merge_alembic_heads`) и голова одна:
  вторая голова валит `alembic upgrade head` с «Multiple head revisions»;
* объявление `ADD COLUMN` совпадает с моделью `MailTemplate` по имени и типу и
  снимается в `downgrade` — иначе ревизия необратима и в базе появляется
  `UndefinedColumn`;
* `upgrade` заполняет `body_html` ровно у строк `invitation` и `activation`,
  не меняет их `subject` и `body`, не создаёт отсутствующий код и не трогает
  `password_recovery`;
* вёрстка из ревизии после подстановки значений не оставляет плейсхолдеров и
  не содержит внешних ресурсов, `<style>`, `flex`/`grid`/`absolute`; картинок в
  ней нет вовсе (домик появился ревизией `0069_mail_hero_house`, см.
  `test_mail_hero_migration.py`).

`IF NOT EXISTS` у `ADD COLUMN` понимает PostgreSQL, а не SQLite, поэтому тест
прогоняет те же операторы без него (`_sqlite_compatible`). Настоящий DDL с
`IF NOT EXISTS` проверяется на стенде: `alembic upgrade head`, затем
`alembic downgrade -1` и снова `alembic upgrade head`.
"""

from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from app.config import get_settings
from app.mail import render_activation_email, render_invitation_email
from app.models.mail_template import MailTemplate
from tests.migration_support import (
    added_columns,
    assert_columns_match_model,
    assert_downgrade_removes_only_added,
    assert_no_external_resources,
    assert_nullable_without_default,
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
MIGRATION_PATH = VERSIONS / "0059_mail_html_bodies.py"
REVISION = "0059_mail_html_bodies"
PARENT = "0058_merge_alembic_heads"

# Префикс колонки, которую заводит ревизия: по нему обвязчик отбирает колонки модели.
COLUMN_PREFIX = "body_html"

INVITATION_CODE = "invitation"
ACTIVATION_CODE = "activation"
RECOVERY_CODE = "password_recovery"

SUBJECT = "Приглашение в систему «Домовой»"
BODY = "Здравствуйте, {full_name}!\nЗадайте пароль: {activation_url}\n"
RECOVERY_SUBJECT = "Восстановление пароля в системе «Домовой»"
RECOVERY_BODY = "Здравствуйте, {full_name}!\nПароль: {activation_url}\n"

ACTIVATION_SUBJECT = "Активация личного кабинета Домовой"


def migration() -> Any:
    """Модуль ревизии по пути: `alembic/versions` — не пакет, импорта по имени нет.

    `Any`, а не `ModuleType`: SQL и функции ревизии объявлены в самом модуле, а не
    в типе. `getattr`/`setattr` тут были бы тише для mypy, но их запрещает
    `ruff check` (`B009`/`B010`), а `# type: ignore` на каждую строку — шум.
    """
    return load_migration(MIGRATION_PATH)


def table_columns(connection: Connection) -> set[str]:
    return {column["name"] for column in sa.inspect(connection).get_columns("mail_templates")}


# --- Дерево ревизий и объявление колонки ------------------------------------


def test_migration_sits_on_top_of_the_previous_head() -> None:
    assert_on_previous_head(migration(), REVISION, PARENT)


def test_revision_tree_has_exactly_one_head() -> None:
    assert_single_head(ALEMBIC_DIR)


def test_added_column_matches_the_model() -> None:
    assert_columns_match_model(migration(), MailTemplate, COLUMN_PREFIX)


def test_added_column_is_nullable_and_has_text_type() -> None:
    """`NULL` — прежнее поведение: шаблон без разметки уходит в старой обёртке."""
    assert_nullable_without_default(migration(), MailTemplate, COLUMN_PREFIX)
    assert added_columns(migration())[COLUMN_PREFIX].upper() == "TEXT"


def test_downgrade_removes_exactly_what_upgrade_added() -> None:
    assert_downgrade_removes_only_added(migration())


# --- Данные: две строки получают вёрстку, остальные остаются как были --------


def test_upgrade_renders_only_the_two_letters(engine_connection: Connection) -> None:
    build_mail_templates(engine_connection)
    insert_template(engine_connection, code=INVITATION_CODE, subject=SUBJECT, body=BODY)
    insert_template(
        engine_connection, code=RECOVERY_CODE, subject=RECOVERY_SUBJECT, body=RECOVERY_BODY
    )

    run_upgrade(engine_connection, MIGRATION_PATH)

    rows = mail_rows(engine_connection)
    assert set(rows) == {ACTIVATION_CODE, INVITATION_CODE, RECOVERY_CODE}

    for code in (INVITATION_CODE, ACTIVATION_CODE):
        assert rows[code].body_html is not None
        assert "Три простых шага — и вы в команде" in rows[code].body_html
    # Восстановление пароля макет не перерисовывает: разметки у него нет.
    assert rows[RECOVERY_CODE].body_html is None

    # `subject` и `body` не тронуты: ревизия ничего не переписывает.
    assert rows[INVITATION_CODE].subject == SUBJECT
    assert rows[INVITATION_CODE].body == BODY
    assert rows[RECOVERY_CODE].subject == RECOVERY_SUBJECT
    assert rows[RECOVERY_CODE].body == RECOVERY_BODY
    assert rows[ACTIVATION_CODE].subject == ACTIVATION_SUBJECT


def test_upgrade_does_not_create_a_missing_template(engine_connection: Connection) -> None:
    """Код `invitation` из ревизии `0016` удалён: `upgrade` не вернёт его обратно."""
    build_mail_templates(engine_connection)
    engine_connection.execute(sa.text("DELETE FROM mail_templates WHERE code = 'invitation'"))

    run_upgrade(engine_connection, MIGRATION_PATH)

    rows = mail_rows(engine_connection)
    assert set(rows) == {ACTIVATION_CODE}
    assert rows[ACTIVATION_CODE].body_html is not None


def test_downgrade_removes_the_column_and_keeps_the_letters(
    engine_connection: Connection,
) -> None:
    build_mail_templates(engine_connection)
    insert_template(engine_connection, code=INVITATION_CODE, subject=SUBJECT, body=BODY)
    run_upgrade(engine_connection, MIGRATION_PATH)
    assert "body_html" in table_columns(engine_connection)

    run_downgrade(engine_connection, MIGRATION_PATH)

    assert "body_html" not in table_columns(engine_connection)
    rows = engine_connection.execute(
        sa.text("SELECT code, subject, body FROM mail_templates")
    ).mappings()
    by_code = {str(row["code"]): row for row in rows}
    assert by_code[INVITATION_CODE]["subject"] == SUBJECT
    assert by_code[INVITATION_CODE]["body"] == BODY
    assert ACTIVATION_CODE in by_code


# --- Вёрстка из ревизии после подстановки -----------------------------------


def test_invitation_html_keeps_no_placeholders_and_names_the_organization(
    db_session: Session,
) -> None:
    db_session.add(
        MailTemplate(
            code=INVITATION_CODE,
            subject=SUBJECT,
            body=BODY,
            body_html=migration().INVITATION_HTML,
            is_active=True,
        )
    )
    db_session.commit()

    rendered = render_invitation_email(
        db_session,
        full_name="Мария Соколова",
        activation_url="https://domovoy.example/activate/abc",
        organization_name="Ромашка",
    )

    html = rendered.html
    assert html is not None
    assert "{" not in html
    assert "Администратор организации «Ромашка» приглашает вас" in html
    assert 'href="https://domovoy.example/activate/abc"' in html
    expires = f"Ссылка действует {get_settings().activation_token_ttl_hours} ч."
    for phrase in (
        "Для вас открыта дверь",
        "Добро пожаловать в вашу команду",
        "Здравствуйте, Мария Соколова!",
        "Задайте пароль",
        "Подтвердите согласия",
        "Начните работу",
        "Принять приглашение",
        "Если кнопка не работает, скопируйте ссылку в браузер:",
        expires,
        "Если вы не ждали приглашения, просто проигнорируйте это письмо.",
        "команда «Домового»",
        "Порядок в общежитиях. Спокойствие в работе.",
        "О сервисе",
        "Политика конфиденциальности",
        "© 2026 Домовой",
    ):
        assert phrase in html, phrase
    assert_no_external_resources(html)


def test_activation_html_differs_only_in_the_letter_specific_parts(db_session: Session) -> None:
    db_session.add(
        MailTemplate(
            code=ACTIVATION_CODE,
            subject=ACTIVATION_SUBJECT,
            body=BODY,
            body_html=migration().ACTIVATION_HTML,
            is_active=True,
        )
    )
    db_session.commit()

    rendered = render_activation_email(
        db_session,
        full_name="Мария Соколова",
        activation_url="https://domovoy.example/activate/abc",
    )

    html = rendered.html
    assert html is not None
    assert "{" not in html
    assert "Добро пожаловать в «Домовой»" in html
    assert "Вы зарегистрировались в системе учёта проживающих «Домовой»." in html
    assert "Активировать кабинет" in html
    assert "Если вы не регистрировались, просто проигнорируйте это письмо." in html
    # У активации нет оборота про организацию: тот, кто зарегистрировался сам,
    # организации ещё не назвал.
    assert "organization" not in html
    assert_no_external_resources(html)
