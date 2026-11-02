"""Ручной план заездов: одна запись на общежитие и день."""

from datetime import date as CalendarDate
from typing import Any
from uuid import uuid4

from sqlalchemy import JSON, CheckConstraint, Date, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

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
    people: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, nullable=True)
    custom_values: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}")
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    visits: Mapped[list["ArrivalVisit"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (
        UniqueConstraint("dormitory_id", "date", name="uq_arrival_plan_dormitory_date"),
        CheckConstraint("count > 0", name="ck_arrival_plan_positive_count"),
    )


class ArrivalSettings(Base):
    __tablename__ = "arrival_settings"

    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    retired_fields: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class ArrivalVisit(Base):
    """Состояние отдельного приезда; значения формы остаются в ArrivalPlan.people."""

    __tablename__ = "arrival_visits"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    plan_id: Mapped[str] = mapped_column(
        ForeignKey("arrival_plans.id", ondelete="CASCADE"), index=True
    )
    person_id: Mapped[str] = mapped_column(String(36))
    lineage_id: Mapped[str] = mapped_column(String(36), index=True)
    status: Mapped[str] = mapped_column(String(16), default="expected")
    arrived_on: Mapped[CalendarDate | None] = mapped_column(Date)
    employee_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    resident_id: Mapped[int | None] = mapped_column(
        ForeignKey("residents.id", ondelete="SET NULL"), unique=True
    )
    resident: Mapped[Any] = relationship("Resident", lazy="joined")
    origin: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    destination: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    previous_status: Mapped[str | None] = mapped_column(String(16))
    history: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    settlement: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    __table_args__ = (
        UniqueConstraint("plan_id", "person_id", name="uq_arrival_visit_person"),
        CheckConstraint(
            "status IN ('expected','arrived','no_show','moved','settled')",
            name="ck_arrival_visit_status",
        ),
    )
