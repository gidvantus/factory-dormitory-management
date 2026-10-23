"""Неизменяемый снимок структуры, без записей и дневных значений."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class DormitoryTemplate(Base):
    __tablename__ = "dormitory_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Организация-владелец снимка. `NULL` — снимок не видно никому: судьбу такого
    # объекта решает владелец данных, поэтому `NOT NULL` не ставится ни в модели,
    # ни в миграции.
    organization_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Имя снимка уникально внутри организации: библиотеки двух организаций
    # независимы.
    __table_args__ = (
        UniqueConstraint(
            "organization_id", "name", name="uq_dormitory_templates_organization_name"
        ),
    )
