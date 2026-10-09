"""Шаблон письма.

Текст письма живёт в базе, а не в коде: правка формулировки не требует релиза.
Подстановки (`{full_name}`, `{activation_url}`, `{expires_hours}`) выполняет `app.mail`.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func, true
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MailTemplate(Base):
    """Именованный шаблон письма. Код `activation` — письмо активации кабинета."""

    __tablename__ = "mail_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
