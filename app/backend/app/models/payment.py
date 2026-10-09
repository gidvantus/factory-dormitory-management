"""Строки списков аванса и расчёта."""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PaymentEntry(Base):
    __tablename__ = "payment_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    personnel_number: Mapped[str | None] = mapped_column(String(40))
    full_name: Mapped[str | None] = mapped_column(String(255))
    advance_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    settlement_date: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
