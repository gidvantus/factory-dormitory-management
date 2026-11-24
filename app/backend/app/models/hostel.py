"""Хостелы вкладки «Размещение персонала» с помесячным периодом активности и дневными данными."""

from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Hostel(Base):
    __tablename__ = "hostels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    active_from_month: Mapped[date] = mapped_column(Date, nullable=False)
    active_until_month: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    layouts: Mapped[dict[str, list[dict[str, Any]]]] = mapped_column(
        JSON, default=dict, server_default=text("'{}'")
    )
    layout_version: Mapped[int] = mapped_column(Integer, server_default=text("0"), default=0)
    occupancy_since: Mapped[date] = mapped_column(
        Date, default=lambda: datetime.now(ZoneInfo("Europe/Moscow")).date()
    )
    resident_fields_since: Mapped[date] = mapped_column(
        Date, default=lambda: datetime.now(ZoneInfo("Europe/Moscow")).date()
    )

    __table_args__ = (
        CheckConstraint(
            "active_until_month IS NULL OR active_until_month >= active_from_month",
            name="ck_hostel_month_order",
        ),
    )


class HostelCell(Base):
    __tablename__ = "hostel_cells"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hostel_id: Mapped[int] = mapped_column(ForeignKey("hostels.id", ondelete="CASCADE"), index=True)
    report_date: Mapped[date] = mapped_column(Date, nullable=False)
    field: Mapped[str] = mapped_column(String(24), nullable=False)
    value: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("hostel_id", "report_date", "field", name="uq_hostel_cell_day_field"),
        CheckConstraint("value >= 0", name="ck_hostel_cell_nonnegative"),
    )


class HostelTemplate(Base):
    __tablename__ = "hostel_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    name_key: Mapped[str] = mapped_column(String(360))
    rows: Mapped[list[dict[str, Any]]] = mapped_column(JSON)

    __table_args__ = (
        UniqueConstraint("organization_id", "name_key", name="uq_hostel_template_name"),
    )


class HostelOccupancyChange(Base):
    __tablename__ = "hostel_occupancy_changes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hostel_id: Mapped[int] = mapped_column(ForeignKey("hostels.id", ondelete="CASCADE"))
    # Связь нужна до завершения проживания, чтобы исправить его историю при позднем оттоке.
    resident_id: Mapped[int | None] = mapped_column(Integer, index=True)
    day: Mapped[date] = mapped_column(Date)
    men: Mapped[int] = mapped_column(Integer)
    women: Mapped[int] = mapped_column(Integer)
    total: Mapped[int] = mapped_column(Integer)
    fields: Mapped[dict[str, dict[str, int]]] = mapped_column(
        JSON, default=dict, server_default=text("'{}'")
    )

    __table_args__ = (Index("ix_hostel_occupancy_day", "hostel_id", "day"),)
