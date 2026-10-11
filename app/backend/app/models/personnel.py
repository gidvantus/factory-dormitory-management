"""Постоянные карточки сотрудников, происхождение сведений и рабочие действия."""

from datetime import date as CalendarDate
from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


def new_id() -> str:
    return str(uuid4())


class Employee(Base):
    __tablename__ = "employees"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    full_name: Mapped[str | None] = mapped_column(String(255))
    personnel_number: Mapped[str | None] = mapped_column(String(40))
    phone: Mapped[str | None] = mapped_column(String(30))
    identity_status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending"
    )
    merged_into_id: Mapped[str | None] = mapped_column(ForeignKey("employees.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmployeeAlias(Base):
    __tablename__ = "employee_aliases"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    field: Mapped[str] = mapped_column(String(24))
    value: Mapped[str] = mapped_column(String(255), index=True)
    raw_value: Mapped[str] = mapped_column(String(255))
    __table_args__ = (UniqueConstraint("employee_id", "field", "value", name="uq_employee_alias"),)


class EmployeeEvent(Base):
    __tablename__ = "employee_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    dormitory_id: Mapped[int | None] = mapped_column(
        ForeignKey("dormitories.id", ondelete="SET NULL"), index=True
    )
    kind: Mapped[str] = mapped_column(String(32))
    source_table: Mapped[str | None] = mapped_column(String(32))
    source_id: Mapped[int | None] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(255))
    happened_on: Mapped[CalendarDate] = mapped_column(Date)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmployeeTask(Base):
    __tablename__ = "employee_tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    text: Mapped[str] = mapped_column(String(300))
    due: Mapped[CalendarDate] = mapped_column(Date)
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    done: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmployeeNote(Base):
    __tablename__ = "employee_notes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    text: Mapped[str] = mapped_column(Text)
    author_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmployeePlan(Base):
    __tablename__ = "employee_plans"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    kind: Mapped[str] = mapped_column(String(12))
    date: Mapped[CalendarDate] = mapped_column(Date, index=True)
    end: Mapped[CalendarDate | None] = mapped_column(Date)
    dormitory_id: Mapped[int] = mapped_column(ForeignKey("dormitories.id"), index=True)
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    comment: Mapped[str] = mapped_column(Text, default="", server_default="")
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmployeeDecision(Base):
    __tablename__ = "employee_decisions"
    resident_id: Mapped[int] = mapped_column(
        ForeignKey("residents.id", ondelete="CASCADE"), primary_key=True
    )
    employee_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    status: Mapped[str] = mapped_column(String(12))
    date: Mapped[CalendarDate | None] = mapped_column(Date)
    original_end: Mapped[CalendarDate | None] = mapped_column(Date)
    comment: Mapped[str] = mapped_column(Text, default="", server_default="")
    plan_id: Mapped[str | None] = mapped_column(
        ForeignKey("employee_plans.id", ondelete="SET NULL")
    )


class EmployeeMerge(Base):
    __tablename__ = "employee_merges"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    source_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    target_id: Mapped[str] = mapped_column(ForeignKey("employees.id"), index=True)
    reason: Mapped[str] = mapped_column(Text)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    undone_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class EmployeeSeparation(Base):
    __tablename__ = "employee_separations"
    pair: Mapped[str] = mapped_column(String(73), primary_key=True)
    signature: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str] = mapped_column(Text)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class PersonnelPreferences(Base):
    __tablename__ = "personnel_preferences"
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class PersonnelBinding(Base):
    __tablename__ = "personnel_bindings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    table_key: Mapped[str] = mapped_column(String(32))
    fields: Mapped[dict[str, int]] = mapped_column(JSON, default=dict)
    __table_args__ = (UniqueConstraint("dormitory_id", "table_key", name="uq_personnel_binding"),)
