"""Почта: шаблон из базы, подстановки и SMTP без сети.

Тесты не ходят в интернет: `smtplib.SMTP_SSL` подменяется фейком, а настройки
SMTP задаются через окружение и сбрасывают кеш `get_settings`.
"""

import logging
import smtplib
from collections.abc import Iterator
from email.message import EmailMessage
from typing import ClassVar

import pytest
from sqlalchemy.orm import Session

from app.config import get_settings
from app.mail import (
    ACTIVATION_TEMPLATE_CODE,
    MailTemplateNotFound,
    activation_email_ready,
    build_activation_url,
    render_activation_email,
    send_activation_email,
)
from app.models.mail_template import MailTemplate

SUBJECT = "Активация личного кабинета Домовой"
BODY = (
    "Здравствуйте, {full_name}!\n"
    "Активируйте кабинет: {activation_url}\n"
    "Ссылка живёт {expires_hours} ч.\n"
)
FULL_NAME = "Иванов Иван Иванович"
TOKEN = "raw-activation-token-value"
SMTP_PASSWORD = "smtp-secret-password"


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


def test_build_activation_url_is_absolute(smtp_settings: None) -> None:
    assert build_activation_url(TOKEN) == f"https://domovoy.example/activate/{TOKEN}"


def test_render_substitutes_every_placeholder(db_session: Session, smtp_settings: None) -> None:
    seed_template(db_session)

    subject, body = render_activation_email(
        db_session,
        full_name=FULL_NAME,
        activation_url="https://domovoy.example/activate/token-value",
    )

    assert subject == SUBJECT
    assert FULL_NAME in body
    assert "https://domovoy.example/activate/token-value" in body
    assert str(get_settings().activation_token_ttl_hours) in body
    assert "{full_name}" not in body
    assert "{activation_url}" not in body


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
