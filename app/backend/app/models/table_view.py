"""Оформление и порядок рабочих таблиц организации."""

from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TableView(Base):
    __tablename__ = "table_views"

    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    scope: Mapped[str] = mapped_column(String(64), primary_key=True)
    table_key: Mapped[str] = mapped_column(String(120), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
