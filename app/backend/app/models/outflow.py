"""Строки оттока персонала по общежитию."""

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.table_column import CustomValuesMixin


class PersonnelOutflow(CustomValuesMixin, Base):
    __tablename__ = "personnel_outflow"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    departure_date: Mapped[date | None] = mapped_column(Date)
    personnel_number: Mapped[str | None] = mapped_column(String(40))
    full_name: Mapped[str | None] = mapped_column(String(255))
    shift_start: Mapped[date | None] = mapped_column(Date)
    reason: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
    additional_info: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
