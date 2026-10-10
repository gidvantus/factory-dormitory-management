"""Почта: единственное место, где приложение разговаривает с SMTP.

Письмо собирается из строки `mail_templates` с нужным кодом — `activation`,
`password_recovery` или `invitation`, — поэтому формулировка правится в базе без
релиза. Открытый токен живёт только в ссылке письма: в логи он не попадает ни
при успехе, ни при ошибке отправки.
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

# Код шаблона письма восстановления пароля: отдельная формулировка для того же экрана.
PASSWORD_RECOVERY_TEMPLATE_CODE = "password_recovery"

# Код шаблона письма-приглашения сотрудника в организацию.
INVITATION_TEMPLATE_CODE = "invitation"

# Лимит писем восстановления: не больше трёх запросов на адрес за окно.
RECOVERY_MAX_REQUESTS_PER_HOUR = 3
RECOVERY_WINDOW_MINUTES = 60

# Столько ждём SMTP-сервер, прежде чем считать попытку неудачной.
SMTP_TIMEOUT_SECONDS = 10


class MailTemplateNotFound(RuntimeError):
    """Шаблона письма нет в базе: отправлять нечего, письмо не уходит."""


class _EmptyPlaceholders(dict[str, str]):
    """Словарь подстановок, который отдаёт пустую строку на неизвестное имя.

    Тема и текст письма правятся прямо в базе, без релиза, поэтому шаблон может
    сослаться на плейсхолдер, которого приложение ещё не знает. `str.format` в
    таком случае падает `KeyError`, письмо не уходит вовсе, а фоновая задача
    завершается ошибкой — вместо этого неизвестное имя должно дать пустую
    строку: текст без него всё равно полезнее неотправленного письма.
    """

    def __missing__(self, key: str) -> str:
        return ""


def _substitute(template: str, context: dict[str, str]) -> str:
    """Подставить значения в шаблон из базы, не падая на незнакомых именах."""
    try:
        return template.format_map(_EmptyPlaceholders(context))
    except (ValueError, IndexError) as error:
        # Незакрытая скобка в шаблоне: письмо всё равно отправляем, но текст
        # останется сырым — об этом должна знать поддержка, а не пользователь.
        logger.warning("Шаблон письма содержит некорректный плейсхолдер: %s", error)
        return template


def build_activation_url(token: str) -> str:
    """Абсолютная ссылка активации: письмо открывается из любого почтовика."""
    settings = get_settings()
    return f"{settings.frontend_base_url.rstrip('/')}/activate/{token}"


def build_recovery_url(token: str) -> str:
    """Абсолютная ссылка восстановления пароля.

    Адрес тот же, что у активации: экран смены пароля один, и ссылка из письма
    восстановления ведёт на него же.
    """
    return build_activation_url(token)


def _active_template(db: Session, code: str) -> MailTemplate | None:
    return db.scalar(
        select(MailTemplate).where(
            MailTemplate.code == code,
            MailTemplate.is_active.is_(True),
        )
    )


def _render_email(
    db: Session, *, code: str, full_name: str, activation_url: str
) -> tuple[str, str]:
    """Тема и текст письма по коду шаблона с подставленными значениями.

    Подстановки у писем активации, восстановления пароля и приглашения
    одинаковые. Отсутствие шаблона — это `MailTemplateNotFound`, а не пустое
    письмо.
    """
    template = _active_template(db, code)
    if template is None:
        raise MailTemplateNotFound(f"Шаблон письма {code!r} не найден")

    context = {
        "full_name": full_name,
        "activation_url": activation_url,
        "expires_hours": str(get_settings().activation_token_ttl_hours),
    }
    return _substitute(template.subject, context), _substitute(template.body, context)


def render_activation_email(db: Session, *, full_name: str, activation_url: str) -> tuple[str, str]:
    """Тема и текст письма активации.

    Шаблон берётся из таблицы `mail_templates` по коду `activation`.
    """
    return _render_email(
        db, code=ACTIVATION_TEMPLATE_CODE, full_name=full_name, activation_url=activation_url
    )


def render_password_recovery_email(
    db: Session, *, full_name: str, activation_url: str
) -> tuple[str, str]:
    """Тема и текст письма восстановления пароля по коду `password_recovery`."""
    return _render_email(
        db,
        code=PASSWORD_RECOVERY_TEMPLATE_CODE,
        full_name=full_name,
        activation_url=activation_url,
    )


def render_invitation_email(db: Session, *, full_name: str, activation_url: str) -> tuple[str, str]:
    """Тема и текст письма-приглашения по коду `invitation`.

    Ссылка ведёт на общий экран активации: задав по ней пароль, приглашённый
    попадает в организацию приглашающего.
    """
    return _render_email(
        db, code=INVITATION_TEMPLATE_CODE, full_name=full_name, activation_url=activation_url
    )


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
    return _active_template(db, ACTIVATION_TEMPLATE_CODE) is not None


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


def _deliver_email(*, to: str, subject: str, body: str, log_label: str) -> bool:
    """Отправить готовое письмо. Ошибки связи и аутентификации наружу не поднимаются."""
    settings = get_settings()
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
        logger.error("%s не отправлено: %s: %s", log_label, type(error).__name__, error)
        return False
    return True


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

    try:
        subject, body = render_activation_email(
            db, full_name=full_name, activation_url=build_activation_url(token)
        )
    except MailTemplateNotFound as error:
        logger.error("Письмо активации не отправлено: %s", error)
        return False

    return _deliver_email(to=to, subject=subject, body=body, log_label="Письмо активации")


def send_password_recovery_email(db: Session, *, to: str, full_name: str, token: str) -> bool:
    """Собрать и отправить письмо восстановления пароля.

    Поведение то же, что у письма активации: `False` вместо исключения, если
    SMTP не настроен или шаблона `password_recovery` нет в базе. Токен и ссылка
    в логи не попадают.
    """
    settings = get_settings()
    if not settings.smtp_host or not settings.smtp_from:
        logger.warning("SMTP не настроен: письмо восстановления пароля не отправлено")
        return False

    try:
        subject, body = render_password_recovery_email(
            db, full_name=full_name, activation_url=build_recovery_url(token)
        )
    except MailTemplateNotFound as error:
        logger.error("Письмо восстановления пароля не отправлено: %s", error)
        return False

    return _deliver_email(
        to=to, subject=subject, body=body, log_label="Письмо восстановления пароля"
    )


def send_invitation_email(db: Session, *, to: str, full_name: str, token: str) -> bool:
    """Собрать и отправить письмо-приглашение сотруднику.

    Поведение то же, что у остальных писем: `False` вместо исключения, если SMTP
    не настроен или шаблона `invitation` нет в базе. Приглашение при этом
    остаётся созданным — администратор видит сотрудника со статусом
    «Приглашение отправлено» и может позвать его повторно.
    """
    settings = get_settings()
    if not settings.smtp_host or not settings.smtp_from:
        logger.warning("SMTP не настроен: письмо-приглашение не отправлено")
        return False

    try:
        subject, body = render_invitation_email(
            db, full_name=full_name, activation_url=build_activation_url(token)
        )
    except MailTemplateNotFound as error:
        logger.error("Письмо-приглашение не отправлено: %s", error)
        return False

    return _deliver_email(to=to, subject=subject, body=body, log_label="Письмо-приглашение")


def send_activation_email_task(*, to: str, full_name: str, token: str) -> None:
    """Фоновая отправка: у задачи своя сессия базы, запрос к этому моменту закрыт."""
    with SessionLocal() as db:
        send_activation_email(db, to=to, full_name=full_name, token=token)


def send_password_recovery_email_task(*, to: str, full_name: str, token: str) -> None:
    """Фоновая отправка письма восстановления — со своей сессией базы."""
    with SessionLocal() as db:
        send_password_recovery_email(db, to=to, full_name=full_name, token=token)


def send_invitation_email_task(*, to: str, full_name: str, token: str) -> None:
    """Фоновая отправка письма-приглашения — со своей сессией базы.

    К моменту вызова запрос уже закрыт, а шаблон письма лежит в базе: сессию
    фоновая задача открывает свою.
    """
    with SessionLocal() as db:
        send_invitation_email(db, to=to, full_name=full_name, token=token)
