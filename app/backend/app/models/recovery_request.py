"""Запрос письма восстановления пароля.

Открытого адреса в таблице нет: хранится только SHA-256 нормализованного email,
поэтому строка не выдаёт, кто именно восстанавливал пароль. Записи нужны только
как счётчик лимита «не больше трёх писем в час», старше окна они не нужны.
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RecoveryRequest(Base):
    """Факт отправки письма восстановления: одна строка на каждый запрос."""

    __tablename__ = "recovery_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    identifier_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
