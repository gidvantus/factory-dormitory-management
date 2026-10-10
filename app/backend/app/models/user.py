"""Модель пользователя."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func, true
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class User(Base):
    """Учётная запись.

    Email хранится в нормализованном виде (без регистра), поэтому обычный
    уникальный индекс по колонке запрещает повторную регистрацию на
    `Ivan@Example.com`, если `ivan@example.com` уже занят.
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    # Организация, от имени которой работает пользователь. Nullable намеренно:
    # колонка необязательна для строк, которых задача ещё не касалась, а сама
    # организация выдаётся активацией кабинета. `SET NULL` — чтобы удаление
    # организации не уносило пользователя.
    active_organization_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
