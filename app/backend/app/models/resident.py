"""Проживающие в общежитии."""

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.table_column import CustomValuesMixin


class Resident(CustomValuesMixin, Base):
    __tablename__ = "residents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    gender: Mapped[str | None] = mapped_column(String(1))
    personnel_number: Mapped[str | None] = mapped_column(String(40))
    full_name: Mapped[str | None] = mapped_column(String(255))
    hostel_id: Mapped[int | None] = mapped_column(
        ForeignKey("hostels.id", ondelete="SET NULL"), index=True
    )
    shift_start: Mapped[date | None] = mapped_column(Date)
    shift_count: Mapped[int | None] = mapped_column(Integer)
    shift_end: Mapped[date | None] = mapped_column(Date)
    phone: Mapped[str | None] = mapped_column(String(30))
    medical_book: Mapped[str | None] = mapped_column(String(12))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
