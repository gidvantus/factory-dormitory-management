"""Почта: единственное место, где приложение разговаривает с SMTP.

Письмо собирается из строки `mail_templates` с кодом `activation`, поэтому
формулировка правится в базе без релиза. Открытый токен активации живёт только
в ссылке письма: в логи он не попадает ни при успехе, ни при ошибке отправки.
"""

import html
import logging
import smtplib
from email.message import EmailMessage

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.models.mail_template import MailTemplate

logger = logging.getLogger(__name__)

# Код шаблона письма активации в таблице `mail_templates`.
ACTIVATION_TEMPLATE_CODE = "activation"

# Столько ждём SMTP-сервер, прежде чем считать попытку неудачной.
SMTP_TIMEOUT_SECONDS = 10


class MailTemplateNotFound(RuntimeError):
    """Шаблона письма нет в базе: отправлять нечего, письмо не уходит."""


def build_activation_url(token: str) -> str:
    """Абсолютная ссылка активации: письмо открывается из любого почтовика."""
    settings = get_settings()
    return f"{settings.frontend_base_url.rstrip('/')}/activate/{token}"


def _active_template(db: Session) -> MailTemplate | None:
    return db.scalar(
        select(MailTemplate).where(
            MailTemplate.code == ACTIVATION_TEMPLATE_CODE,
            MailTemplate.is_active.is_(True),
        )
    )


def render_activation_email(db: Session, *, full_name: str, activation_url: str) -> tuple[str, str]:
    """Тема и текст письма активации с подставленными значениями.

    Шаблон берётся из таблицы `mail_templates` по коду `activation`. Отсутствие
    шаблона — это `MailTemplateNotFound`, а не пустое письмо.
    """
    template = _active_template(db)
    if template is None:
        raise MailTemplateNotFound(f"Шаблон письма {ACTIVATION_TEMPLATE_CODE!r} не найден")

    context = {
        "full_name": full_name,
        "activation_url": activation_url,
        "expires_hours": str(get_settings().activation_token_ttl_hours),
    }
    return template.subject.format(**context), template.body.format(**context)


def activation_email_ready(db: Session) -> bool:
    """Есть ли всё, чтобы письмо ушло: шаблон и настроенный SMTP.

    Ответ регистрации отдаёт это значение в `activation_email_sent`, поэтому
    проверка синхронная и дешёвая — сама отправка идёт фоном.
    """
    settings = get_settings()
    if not settings.smtp_host or not settings.smtp_from:
        return False
    if settings.smtp_user and not settings.smtp_password:
        return False
    return _active_template(db) is not None


def _html_from_text(body: str) -> str:
    escaped = html.escape(body).replace("\n", "<br>")
    return (
        '<html><body style="font-family:Arial,Helvetica,sans-serif;'
        f'font-size:15px;color:#27313D">{escaped}</body></html>'
    )


def _open_smtp(host: str, port: int, use_tls: bool) -> smtplib.SMTP:
    if use_tls:
        return smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT_SECONDS)
    return smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT_SECONDS)


def send_activation_email(db: Session, *, to: str, full_name: str, token: str) -> bool:
    """Собрать и отправить письмо активации.

    Возвращает `True` только при успешной отправке. Ошибки связи и
    аутентификации логируются без ссылки и токена и не поднимаются наружу:
    регистрация из-за недоступного SMTP падать не должна.
    """
    settings = get_settings()
    if not settings.smtp_host or not settings.smtp_from:
        logger.warning("SMTP не настроен: письмо активации не отправлено")
        return False

    activation_url = build_activation_url(token)
    try:
        subject, body = render_activation_email(
            db, full_name=full_name, activation_url=activation_url
        )
    except MailTemplateNotFound as error:
        logger.error("Письмо активации не отправлено: %s", error)
        return False

    message = EmailMessage()
    message["From"] = settings.smtp_from
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    message.add_alternative(_html_from_text(body), subtype="html")

    try:
        with _open_smtp(settings.smtp_host, settings.smtp_port, settings.smtp_use_tls) as smtp:
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as error:
        logger.error("Письмо активации не отправлено: %s: %s", type(error).__name__, error)
        return False
    return True


def send_activation_email_task(*, to: str, full_name: str, token: str) -> None:
    """Фоновая отправка: у задачи своя сессия базы, запрос к этому моменту закрыт."""
    with SessionLocal() as db:
        send_activation_email(db, to=to, full_name=full_name, token=token)
