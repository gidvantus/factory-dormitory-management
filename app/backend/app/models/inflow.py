"""Строки притока персонала по общежитию."""

from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.table_column import CustomValuesMixin


class PersonnelInflow(CustomValuesMixin, Base):
    __tablename__ = "personnel_inflow"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    settlement_date: Mapped[date | None] = mapped_column(Date)
    personnel_number: Mapped[str | None] = mapped_column(String(40))
    full_name: Mapped[str | None] = mapped_column(String(255))
    citizenship: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)
    shift_count: Mapped[int | None] = mapped_column(Integer)
    processed_as: Mapped[str | None] = mapped_column(String(16))
    processed_row_id: Mapped[int | None] = mapped_column(Integer)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
