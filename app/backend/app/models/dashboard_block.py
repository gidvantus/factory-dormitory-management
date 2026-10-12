"""Общие пользовательские блоки и порядок карточек дашборда."""

from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

DEFAULT_DASHBOARD_ORDER = ["residents", "turnover", "attendance", "reports"]


class DashboardLayout(Base):
    __tablename__ = "dashboard_layout"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    order: Mapped[list[str]] = mapped_column(JSON, default=lambda: list(DEFAULT_DASHBOARD_ORDER))
    hidden: Mapped[list[str]] = mapped_column(JSON, default=list, server_default=text("'[]'"))


class DashboardBlock(Base):
    __tablename__ = "dashboard_blocks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
