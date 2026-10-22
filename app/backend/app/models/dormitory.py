"""Общежития, созданные пользователями.

Общежитие принадлежит организации, и эта колонка — единственная точка правды о
принадлежности данных кабинета: на `dormitory_id` висят все операционные таблицы,
поэтому дочерние строки наследуют принадлежность от корня и своей колонки не
имеют. `ON DELETE RESTRICT`: удаление организации не должно молча прятать её
общежития.
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, false, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Dormitory(Base):
    __tablename__ = "dormitories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Организация, которой принадлежат данные общежития. `NOT NULL` ставит
    # миграция `0043_dormitories_organization` после backfill: до него колонка
    # nullable, иначе существующие строки нечем заполнить.
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    client_name: Mapped[str] = mapped_column(String(255), nullable=False)
    section_states: Mapped[dict[str, str]] = mapped_column(
        JSON, default=dict, server_default=text("'{}'")
    )
    section_parents: Mapped[dict[str, str | None]] = mapped_column(
        JSON, default=dict, server_default=text("'{}'")
    )
    is_archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
