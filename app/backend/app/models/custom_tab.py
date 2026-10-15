"""Пользовательские вкладки и строки их таблиц внутри одного общежития."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, false, func, true
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.table_column import CustomValuesMixin


class CustomTab(Base):
    __tablename__ = "custom_tabs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("custom_tabs.id", ondelete="CASCADE"), nullable=True, index=True
    )
    is_group: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    parent_section: Mapped[str | None] = mapped_column(String(24), nullable=True)
    table_created: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}")

    @property
    def table_key(self) -> str:
        return f"custom_{self.id}"


class CustomTabEntry(CustomValuesMixin, Base):
    __tablename__ = "custom_tab_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    tab_id: Mapped[int] = mapped_column(
        ForeignKey("custom_tabs.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    calendar_values: Mapped[dict[str, str]] = mapped_column(JSON, default=dict, server_default="{}")
