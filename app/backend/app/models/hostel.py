"""Хостелы вкладки «Места» с помесячным периодом активности и дневными данными."""

from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
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
