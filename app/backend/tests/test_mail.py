"""Почта: шаблон из базы, подстановки и SMTP без сети.

Тесты не ходят в интернет: `smtplib.SMTP_SSL` подменяется фейком, а настройки
SMTP задаются через окружение и сбрасывают кеш `get_settings`.
"""

import logging
import smtplib
from collections.abc import Iterator
from email.message import EmailMessage
from pathlib import Path
from typing import ClassVar

import pytest
from sqlalchemy.orm import Session

from app import mail as mail_module
from app.config import get_settings
from app.mail import (
    ACTIVATION_TEMPLATE_CODE,
    HOUSE_IMAGE_CID,
    INVITATION_TEMPLATE_CODE,
    PASSWORD_RECOVERY_TEMPLATE_CODE,
    MailTemplateNotFound,
    activation_email_ready,
    build_activation_url,
    build_recovery_url,
    render_activation_email,
    render_password_recovery_email,
    send_activation_email,
    send_invitation_email,
    send_password_recovery_email,
)
from app.models.mail_template import MailTemplate
from tests.migration_support import load_migration

SUBJECT = "Активация личного кабинета Домовой"
BODY = (
    "Здравствуйте, {full_name}!\n"
    "Активируйте кабинет: {activation_url}\n"
    "Ссылка живёт {expires_hours} ч.\n"
)
RECOVERY_SUBJECT = "Восстановление пароля в системе «Домовой»"
RECOVERY_BODY = (
    "Здравствуйте, {full_name}!\n"
    "Задайте новый пароль: {activation_url}\n"
    "Ссылка живёт {expires_hours} ч.\n"
)
FULL_NAME = "Иванов Иван Иванович"
TOKEN = "raw-activation-token-value"
SMTP_PASSWORD = "smtp-secret-password"
# Имя со спецсимволами: в plain-части оно уходит как есть, в HTML — экранированным.
TRICKY_FULL_NAME = "Иванов <Иван> & Ко"
# HTML-часть шаблона: мини-копия вёрстки из `0059_mail_html_bodies`, без таблиц —
# тесту важно поведение подстановки, а не разметка письма.
HTML_BODY = (
    '<html lang="ru"><head><meta charset="utf-8"><title>{subject}</title></head>'
    '<body style="font-family:Arial,Helvetica,sans-serif">'
    "<p>Здравствуйте, {full_name}!</p>"
    '<p><a href="{activation_url}">{activation_url}</a></p>'
    "<p>Ссылка действует {expires_hours} ч.</p>"
    '<p><a href="{site_url}/">О сервисе</a></p>'
    "</body></html>"
)

# Та же мини-разметка, но с домиком-вложением: `cid` совпадает с `Content-ID`
# части, которую `_deliver_email` прикрепляет к HTML-части.
HTML_BODY_WITH_HOUSE = (
    '<html lang="ru"><head><meta charset="utf-8"><title>{subject}</title></head>'
    '<body style="font-family:Arial,Helvetica,sans-serif">'
    "<p>Здравствуйте, {full_name}!</p>"
    f'<p><img src="cid:{HOUSE_IMAGE_CID}" width="112" height="112" alt=""></p>'
    '<p><a href="{activation_url}">{activation_url}</a></p>'
    "</body></html>"
)

# Картинка домика на диске: байты вложения обязаны совпадать с файлом.
HOUSE_IMAGE_PATH = Path(__file__).resolve().parents[1] / "app" / "mail_assets" / "house-hero.png"

# Ревизия, которая проставляет вёрстку с домиком: её вёрстка — настоящая, из базы,
# а не мини-копия выше. Письмо из неё проверяется целиком, от разметки до MIME.
HERO_MIGRATION_PATH = (
    Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0069_mail_hero_house.py"
)


class FakeSMTP:
    """Минимальная замена smtplib.SMTP_SSL: запоминает письма и попытки входа."""

    sent: ClassVar[list[EmailMessage]] = []
    logins: ClassVar[list[tuple[str, str]]] = []
    opened: ClassVar[list[tuple[str, int, float | None]]] = []

    def __init__(self, host: str, port: int, timeout: float | None = None) -> None:
        FakeSMTP.opened.append((host, port, timeout))

    def __enter__(self) -> "FakeSMTP":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def login(self, user: str, password: str) -> None:
        FakeSMTP.logins.append((user, password))

    def send_message(self, message: EmailMessage) -> None:
        FakeSMTP.sent.append(message)

    @classmethod
    def reset(cls) -> None:
        cls.sent = []
        cls.logins = []
        cls.opened = []


class FailingSMTP(FakeSMTP):
    def login(self, user: str, password: str) -> None:
        raise smtplib.SMTPAuthenticationError(535, b"authentication failed")


@pytest.fixture(autouse=True)
def settings_cache() -> Iterator[None]:
    """Кеш настроек не должен переживать подмену окружения в отдельном тесте."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def fake_smtp(monkeypatch: pytest.MonkeyPatch) -> Iterator[type[FakeSMTP]]:
    FakeSMTP.reset()
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    yield FakeSMTP
    FakeSMTP.reset()


@pytest.fixture
def smtp_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный SMTP: без него отправка выходит до первого сетевого вызова."""
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setenv("SMTP_USER", "robot@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", SMTP_PASSWORD)
    monkeypatch.setenv("SMTP_FROM", "robot@example.com")
    monkeypatch.setenv("SMTP_USE_TLS", "true")
    monkeypatch.setenv("FRONTEND_BASE_URL", "https://domovoy.example")
    get_settings.cache_clear()
    yield


def seed_template(db_session: Session, is_active: bool = True) -> MailTemplate:
    template = MailTemplate(
        code=ACTIVATION_TEMPLATE_CODE, subject=SUBJECT, body=BODY, is_active=is_active
    )
    db_session.add(template)
    db_session.commit()
    db_session.refresh(template)
    return template


def seed_recovery_template(db_session: Session, is_active: bool = True) -> MailTemplate:
    template = MailTemplate(
        code=PASSWORD_RECOVERY_TEMPLATE_CODE,
        subject=RECOVERY_SUBJECT,
        body=RECOVERY_BODY,
        is_active=is_active,
    )
    db_session.add(template)
    db_session.commit()
    db_session.refresh(template)
    return template


def seed_html_template(db_session: Session, body_html: str = HTML_BODY) -> MailTemplate:
    """Шаблон активации с вёрстанной HTML-частью."""
    template = MailTemplate(
        code=ACTIVATION_TEMPLATE_CODE,
        subject=SUBJECT,
        body=BODY,
        body_html=body_html,
        is_active=True,
    )
    db_session.add(template)
    db_session.commit()
    db_session.refresh(template)
    return template


def test_build_activation_url_is_absolute(smtp_settings: None) -> None:
    assert build_activation_url(TOKEN) == f"https://domovoy.example/activate/{TOKEN}"


def test_build_recovery_url_leads_to_the_same_password_screen(smtp_settings: None) -> None:
    """Экран смены пароля один, поэтому адрес восстановления совпадает с активацией."""
    assert build_recovery_url(TOKEN) == f"https://domovoy.example/activate/{TOKEN}"


def test_render_substitutes_every_placeholder(db_session: Session, smtp_settings: None) -> None:
    seed_template(db_session)

    rendered = render_activation_email(
        db_session,
        full_name=FULL_NAME,
        activation_url="https://domovoy.example/activate/token-value",
    )
    subject, body = rendered.subject, rendered.body

    assert subject == SUBJECT
    assert FULL_NAME in body
    assert "https://domovoy.example/activate/token-value" in body
    assert str(get_settings().activation_token_ttl_hours) in body
    assert "{full_name}" not in body
    assert "{activation_url}" not in body
    # Разметки у этого шаблона нет: HTML-часть собирается прежней обёрткой.
    assert rendered.html is None


def test_render_raises_when_template_is_missing(db_session: Session) -> None:
    with pytest.raises(MailTemplateNotFound):
        render_activation_email(
            db_session, full_name=FULL_NAME, activation_url="https://example/activate/x"
        )


def test_render_skips_inactive_template(db_session: Session, smtp_settings: None) -> None:
    seed_template(db_session, is_active=False)

    with pytest.raises(MailTemplateNotFound):
        render_activation_email(
            db_session, full_name=FULL_NAME, activation_url="https://example/activate/x"
        )


def test_ready_requires_smtp_and_template(db_session: Session, smtp_settings: None) -> None:
    assert activation_email_ready(db_session) is False
    seed_template(db_session)
    assert activation_email_ready(db_session) is True


def test_not_ready_without_password(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    seed_template(db_session)
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_FROM", "robot@example.com")
    monkeypatch.setenv("SMTP_USER", "robot@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "")
    get_settings.cache_clear()

    assert activation_email_ready(db_session) is False


def test_send_builds_message_and_logs_in(db_session: Session, smtp_settings: None) -> None:
    seed_template(db_session)

    assert send_activation_email(
        db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
    )
    assert FakeSMTP.opened == [("smtp.example.com", 465, 10)]
    assert FakeSMTP.logins == [("robot@example.com", SMTP_PASSWORD)]

    (message,) = FakeSMTP.sent
    assert message["From"] == "robot@example.com"
    assert message["To"] == "worker@example.com"
    assert message["Subject"] == SUBJECT

    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    assert f"https://domovoy.example/activate/{TOKEN}" in plain.get_content()
    content_types = [part.get_content_type() for part in message.walk()]
    assert "text/plain" in content_types
    assert "text/html" in content_types


def test_send_without_template_logs_and_returns_false(
    db_session: Session, caplog: pytest.LogCaptureFixture, smtp_settings: None
) -> None:
    with caplog.at_level(logging.ERROR):
        sent = send_activation_email(
            db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
        )

    assert sent is False
    assert FakeSMTP.sent == []
    assert ACTIVATION_TEMPLATE_CODE in caplog.text


def test_smtp_failure_is_logged_without_the_token(
    db_session: Session,
    caplog: pytest.LogCaptureFixture,
    smtp_settings: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed_template(db_session)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FailingSMTP)

    with caplog.at_level(logging.ERROR):
        sent = send_activation_email(
            db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
        )

    assert sent is False
    assert caplog.text
    assert TOKEN not in caplog.text
    assert SMTP_PASSWORD not in caplog.text


def test_send_is_skipped_without_smtp_host(
    db_session: Session, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Без SMTP_HOST регистрация не должна ни падать, ни стучаться в сеть."""
    monkeypatch.setenv("SMTP_HOST", "")
    get_settings.cache_clear()
    seed_template(db_session)

    with caplog.at_level(logging.WARNING):
        sent = send_activation_email(
            db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
        )

    assert sent is False
    assert FakeSMTP.opened == []


def test_recovery_render_substitutes_every_placeholder(
    db_session: Session, smtp_settings: None
) -> None:
    seed_recovery_template(db_session)

    rendered = render_password_recovery_email(
        db_session,
        full_name=FULL_NAME,
        activation_url="https://domovoy.example/activate/token-value",
    )
    subject, body = rendered.subject, rendered.body

    assert subject == RECOVERY_SUBJECT
    assert FULL_NAME in body
    assert "https://domovoy.example/activate/token-value" in body
    assert str(get_settings().activation_token_ttl_hours) in body
    assert "{full_name}" not in body
    assert "{activation_url}" not in body
    assert "{expires_hours}" not in body
    # Восстановление пароля макет не перерисовывает: HTML-части нет.
    assert rendered.html is None


def test_send_recovery_builds_message_from_its_own_template(
    db_session: Session, smtp_settings: None
) -> None:
    seed_recovery_template(db_session)

    assert send_password_recovery_email(
        db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
    )

    (message,) = FakeSMTP.sent
    assert message["Subject"] == RECOVERY_SUBJECT
    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    assert f"https://domovoy.example/activate/{TOKEN}" in plain.get_content()


def test_send_recovery_without_template_logs_and_returns_false(
    db_session: Session, caplog: pytest.LogCaptureFixture, smtp_settings: None
) -> None:
    """Есть только шаблон активации: письмо восстановления не уходит и не падает."""
    seed_template(db_session)

    with caplog.at_level(logging.ERROR):
        sent = send_password_recovery_email(
            db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
        )

    assert sent is False
    assert FakeSMTP.sent == []
    assert PASSWORD_RECOVERY_TEMPLATE_CODE in caplog.text
    assert TOKEN not in caplog.text


def test_render_puts_an_empty_string_for_an_unknown_placeholder(
    db_session: Session, smtp_settings: None
) -> None:
    """Тема и текст правятся в базе: незнакомое имя не должно ломать письмо.

    Раньше `str.format` падал `KeyError`, отправка обрывалась, а пользователь не
    получал ссылку. Неизвестный плейсхолдер теперь даёт пустую строку.
    """
    template = seed_template(db_session)
    template.subject = "Активация для {unknown_role}"
    template.body = "Здравствуйте, {full_name}! Ваша роль: {unknown_role}. {activation_url}"
    db_session.commit()

    rendered = render_activation_email(
        db_session, full_name=FULL_NAME, activation_url="https://example/activate/x"
    )
    subject, body = rendered.subject, rendered.body

    assert subject == "Активация для "
    assert body.startswith(f"Здравствуйте, {FULL_NAME}!")
    assert "Ваша роль: ." in body
    assert "https://example/activate/x" in body


def test_send_survives_an_unknown_placeholder(db_session: Session, smtp_settings: None) -> None:
    """Письмо с незнакомым плейсхолдером всё равно уходит — со ссылкой внутри."""
    template = seed_template(db_session)
    template.body = template.body + "Роль: {unknown_role}\n"
    db_session.commit()

    assert send_activation_email(
        db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
    )

    (message,) = FakeSMTP.sent
    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    text = plain.get_content()
    assert "Роль:" in text
    assert f"https://domovoy.example/activate/{TOKEN}" in text


# --- HTML-часть письма из `mail_templates.body_html` --------------------------


def html_part(message: EmailMessage) -> str:
    """Готовая HTML-часть отправленного письма."""
    part = message.get_body(preferencelist=("html",))
    assert part is not None
    return part.get_content()


def test_html_part_is_rendered_from_the_template(db_session: Session, smtp_settings: None) -> None:
    """HTML-часть берётся из `body_html`: ссылка абсолютная, плейсхолдеров не осталось."""
    seed_html_template(db_session)

    assert send_activation_email(
        db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
    )

    (message,) = FakeSMTP.sent
    rendered = html_part(message)
    activation_url = f"https://domovoy.example/activate/{TOKEN}"
    assert f'href="{activation_url}"' in rendered
    assert f">{activation_url}</a>" in rendered
    assert FULL_NAME in rendered
    assert str(get_settings().activation_token_ttl_hours) in rendered
    assert "https://domovoy.example/" in rendered
    # Тема подставлена в `<title>` HTML-части.
    assert f"<title>{SUBJECT}</title>" in rendered
    assert "{" not in rendered

    # Plain-часть остаётся plain-текстом и несёт ту же ссылку, что и раньше.
    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    text = plain.get_content()
    assert activation_url in text
    assert "<a href" not in text
    content_types = [part.get_content_type() for part in message.walk()]
    assert content_types.count("text/plain") == 1
    assert content_types.count("text/html") == 1


def test_html_values_are_escaped_and_plain_values_are_not(
    db_session: Session, smtp_settings: None
) -> None:
    """Имя со спецсимволами: в HTML экранировано, в plain-части — как есть."""
    seed_html_template(db_session)

    assert send_activation_email(
        db_session, to="worker@example.com", full_name=TRICKY_FULL_NAME, token=TOKEN
    )

    (message,) = FakeSMTP.sent
    rendered = html_part(message)
    assert "Иванов &lt;Иван&gt; &amp; Ко" in rendered
    assert TRICKY_FULL_NAME not in rendered

    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    assert TRICKY_FULL_NAME in plain.get_content()


def test_template_without_body_html_keeps_the_old_wrapper(
    db_session: Session, smtp_settings: None
) -> None:
    """Шаблон без разметки (`password_recovery` в базе) уходит в прежней обёртке."""
    seed_recovery_template(db_session)

    assert send_password_recovery_email(
        db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
    )

    (message,) = FakeSMTP.sent
    rendered = html_part(message)
    assert rendered.startswith('<html><body style="font-family:Arial,Helvetica,sans-serif;')
    assert "<br>" in rendered
    assert "<table" not in rendered
    assert "<a href" not in rendered


def test_unknown_placeholder_in_html_gives_an_empty_string(
    db_session: Session, smtp_settings: None
) -> None:
    """Незнакомое имя в `body_html` не ломает отправку: письмо всё равно уходит."""
    template = seed_html_template(
        db_session,
        body_html="<p>Здравствуйте, {full_name}! Роль: {unknown_role}</p>"
        '<p><a href="{activation_url}">Открыть</a></p>',
    )
    assert template.body_html is not None

    assert send_activation_email(
        db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
    )

    (message,) = FakeSMTP.sent
    rendered = html_part(message)
    assert "Роль: </p>" in rendered
    assert "{" not in rendered
    assert f'href="https://domovoy.example/activate/{TOKEN}"' in rendered


# --- Домик вложением с `cid` --------------------------------------------------


def image_parts(message: EmailMessage) -> list[EmailMessage]:
    """Части-картинки отправленного письма: вложение, а не ссылка."""
    return [part for part in message.walk() if part.get_content_type() == "image/png"]


def test_html_with_cid_attaches_the_house_image(db_session: Session, smtp_settings: None) -> None:
    """Разметка со ссылкой на `cid` привозит домик частью `image/png` внутри письма."""
    seed_html_template(db_session, body_html=HTML_BODY_WITH_HOUSE)

    assert send_activation_email(
        db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
    )

    (message,) = FakeSMTP.sent
    related = [part for part in message.walk() if part.get_content_type() == "multipart/related"]
    assert len(related) == 1

    (image,) = image_parts(message)
    assert image["Content-ID"] == f"<{HOUSE_IMAGE_CID}>"
    assert image.get_filename() == "domovoy-house.png"
    disposition = image["Content-Disposition"]
    assert disposition is not None
    assert disposition.startswith("inline")
    payload = image.get_payload(decode=True)
    assert payload is not None
    assert payload == HOUSE_IMAGE_PATH.read_bytes()

    # HTML-часть осталась на месте и ссылается на вложение по `cid`.
    rendered = html_part(message)
    assert f'src="cid:{HOUSE_IMAGE_CID}"' in rendered
    assert f"<title>{SUBJECT}</title>" in rendered

    # Plain-часть не изменилась: картинка живёт только в HTML-представлении.
    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    assert f"https://domovoy.example/activate/{TOKEN}" in plain.get_content()
    assert "cid:" not in plain.get_content()


def test_html_without_cid_has_no_image_part(db_session: Session, smtp_settings: None) -> None:
    """Шаблон без ссылки на `cid` уходит как раньше — без частей `image/png`."""
    seed_html_template(db_session)

    assert send_activation_email(
        db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
    )

    (message,) = FakeSMTP.sent
    assert image_parts(message) == []
    assert "cid:" not in html_part(message)


def test_missing_house_image_does_not_stop_the_letter(
    db_session: Session,
    caplog: pytest.LogCaptureFixture,
    smtp_settings: None,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Файла картинки нет — письмо всё равно уходит, без вложения: письмо важнее."""
    seed_html_template(db_session, body_html=HTML_BODY_WITH_HOUSE)
    monkeypatch.setattr(mail_module, "HOUSE_IMAGE_PATH", tmp_path / "house-hero.png")

    with caplog.at_level(logging.ERROR):
        sent = send_activation_email(
            db_session, to="worker@example.com", full_name=FULL_NAME, token=TOKEN
        )

    assert sent is True
    (message,) = FakeSMTP.sent
    assert image_parts(message) == []
    # Ссылка на `cid` в разметке осталась: без картинки на её месте пустое место.
    assert f'src="cid:{HOUSE_IMAGE_CID}"' in html_part(message)
    assert "house-hero.png" in caplog.text
    assert TOKEN not in caplog.text


def test_letter_from_the_revision_carries_the_house_attachment(
    db_session: Session, smtp_settings: None
) -> None:
    """Письмо из настоящей вёрстки ревизии уходит с домиком-вложением.

    Мини-разметка выше проверяет поведение отправки, а этот тест — тот самый вид
    письма, что лежит в `mail_templates` после `0069_mail_hero_house`: ровно одна
    ссылка `cid:`, ни одного внешнего `src`, вложение — файл с диска.
    """
    migration = load_migration(HERO_MIGRATION_PATH)
    db_session.add(
        MailTemplate(
            code=INVITATION_TEMPLATE_CODE,
            subject=SUBJECT,
            body=BODY,
            body_html=migration.INVITATION_HTML,
            is_active=True,
        )
    )
    db_session.commit()

    assert send_invitation_email(
        db_session,
        to="worker@example.com",
        full_name=FULL_NAME,
        token=TOKEN,
        organization_name="Ромашка",
    )

    (message,) = FakeSMTP.sent
    rendered = html_part(message)
    assert rendered.count(f'src="cid:{HOUSE_IMAGE_CID}"') == 1
    assert 'src="http' not in rendered
    assert 'src="data:' not in rendered
    assert "<style" not in rendered
    assert "display:flex" not in rendered
    assert "position:absolute" not in rendered

    (image,) = image_parts(message)
    assert image["Content-ID"] == f"<{HOUSE_IMAGE_CID}>"
    payload = image.get_payload(decode=True)
    assert payload is not None
    assert payload == HOUSE_IMAGE_PATH.read_bytes()

    # Plain-часть прежняя: картинка её не касается.
    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    assert "cid:" not in plain.get_content()
