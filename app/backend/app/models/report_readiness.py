"""Ежедневное ручное подтверждение готовности отчёта общежития."""

from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, UniqueConstraint, false
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ReportReadiness(Base):
    __tablename__ = "report_readiness"
    __table_args__ = (UniqueConstraint("dormitory_id", "report_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    report_date: Mapped[date] = mapped_column(Date, nullable=False)
    is_ready: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=false())
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confirmed_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
