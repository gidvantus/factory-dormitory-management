"""Публичный документ сервиса.

Политика конфиденциальности, правила использования и оферта лежат в базе, а не
в разметке фронта: правка текста — это SQL-запрос или миграция, пересборка
фронта для неё не нужна. Признака публикации нет: все строки таблицы публичны,
скрывать документ нечем. Версий тоже нет — в таблице одна актуальная редакция.
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Document(Base):
    """Документ сервиса. `code` — часть публичного адреса `/documents/<code>`."""

    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
