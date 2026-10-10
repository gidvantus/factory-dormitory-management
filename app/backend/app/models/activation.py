"""Токен активации личного кабинета.

В таблице лежит только SHA-256 открытого токена: утечка строки из базы не даёт
возможности активировать чужой кабинет. Срок жизни задаёт `activation_token_ttl_hours`.

`kind` различает письмо активации (`activation`), письмо восстановления пароля
(`recovery`) и приглашение сотрудника в организацию (`invitation`). Экран у них
общий: все три ссылки ведут на страницу активации, разница только в тексте
письма, которое ушло пользователю.
"""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# Виды одноразовых ссылок. Перечень для `CHECK` собирается из константы, чтобы
# модель и миграция не разошлись.
ACTIVATION_TOKEN_KINDS = ("activation", "recovery", "invitation")

ACTIVATION_TOKEN_KINDS_SQL = ", ".join(f"'{kind}'" for kind in ACTIVATION_TOKEN_KINDS)


class ActivationToken(Base):
    """Одноразовая ссылка активации, восстановления пароля или приглашения."""

    __tablename__ = "activation_tokens"
    __table_args__ = (
        CheckConstraint(
            f"kind IN ({ACTIVATION_TOKEN_KINDS_SQL})", name="ck_activation_tokens_kind"
        ),
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
