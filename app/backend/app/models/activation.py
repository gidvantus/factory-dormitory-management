"""Токен активации личного кабинета.

В таблице лежит только SHA-256 открытого токена: утечка строки из базы не даёт
возможности активировать чужой кабинет. Срок жизни задаёт `activation_token_ttl_hours`.

`kind` различает письмо активации (`activation`) и письмо восстановления пароля
(`recovery`). Смена пароля у них общая: обе ссылки ведут на один экран, разница
только в тексте письма, которое ушло пользователю.
"""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ActivationToken(Base):
    """Одноразовая ссылка активации или восстановления пароля, выпущенная на пользователя."""

    __tablename__ = "activation_tokens"
    __table_args__ = (
        CheckConstraint("kind IN ('activation', 'recovery')", name="ck_activation_tokens_kind"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(
        String(30), nullable=False, default="activation", server_default="activation"
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
