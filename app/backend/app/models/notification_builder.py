"""Личные уведомления с расписанием и снимками отложенных событий."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, func, true
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PersonalNotification(Base):
    __tablename__ = "personal_notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    observed: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    pending: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
