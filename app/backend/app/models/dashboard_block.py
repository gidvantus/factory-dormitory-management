"""Пользовательские блоки и порядок карточек дашборда организации."""

from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

DEFAULT_DASHBOARD_ORDER = ["residents", "turnover", "attendance", "reports"]


class DashboardLayout(Base):
    """Раскладка дашборда: одна строка на организацию.

    `organization_id` остаётся `nullable=True` — это правило, а не компромисс:
    `NULL` значит «раскладка, не принадлежащая никому», и её не отдаёт ни одна
    организация (то же правило, что у корневых объектов в `0045`).
    Уникальность `organization_id` — гарантия «одна раскладка на организацию».
    """

    __tablename__ = "dashboard_layout"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), unique=True
    )
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    order: Mapped[list[str]] = mapped_column(JSON, default=lambda: list(DEFAULT_DASHBOARD_ORDER))
    hidden: Mapped[list[str]] = mapped_column(JSON, default=list, server_default=text("'[]'"))


class DashboardBlock(Base):
    """Пользовательский блок статистики: блок принадлежит организации.

    `NULL` и здесь значит «не виден никому»: блок, автора которого привязать
    не удалось, остаётся в таблице, но ни одна организация его не получает.
    `ON DELETE RESTRICT` — удаление организации не должно молча прятать блоки.
    """

    __tablename__ = "dashboard_blocks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), index=True
    )
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
