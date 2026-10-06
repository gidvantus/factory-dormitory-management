"""Строки притока персонала по общежитию."""

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PersonnelInflow(Base):
    __tablename__ = "personnel_inflow"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    settlement_date: Mapped[date | None] = mapped_column(Date)
    personnel_number: Mapped[str | None] = mapped_column(String(40))
    full_name: Mapped[str | None] = mapped_column(String(255))
    citizenship: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)
    shift_count: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
