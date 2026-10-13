"""Ручной план заездов: одна запись на общежитие и день."""

from datetime import date as CalendarDate
from uuid import uuid4

from sqlalchemy import JSON, CheckConstraint, Date, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ArrivalPlan(Base):
    __tablename__ = "arrival_plans"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    date: Mapped[CalendarDate] = mapped_column(Date, index=True)
    count: Mapped[int] = mapped_column(Integer)
    names: Mapped[list[str]] = mapped_column(JSON, default=list)
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    __table_args__ = (
        UniqueConstraint("dormitory_id", "date", name="uq_arrival_plan_dormitory_date"),
        CheckConstraint("count > 0", name="ck_arrival_plan_positive_count"),
    )
