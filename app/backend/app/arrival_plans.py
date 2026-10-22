"""Общие данные плана заездов и источника общего отчёта."""

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.arrival_plan import ArrivalPlan
from app.models.dormitory import Dormitory


def plan_response(plan: ArrivalPlan) -> dict[str, Any]:
    return {
        "id": plan.id,
        "dormitory_id": plan.dormitory_id,
        "date": plan.date,
        "count": plan.count,
        "names": plan.names,
        "revision": plan.revision,
    }


def active_arrivals(db: Session, dormitory_ids: list[int] | None = None) -> list[dict[str, Any]]:
    """Планы заездов по действующим общежитиям; область — список `dormitory_ids`."""
    statement = (
        select(ArrivalPlan)
        .join(Dormitory)
        .where(Dormitory.is_archived.is_(False))
        .order_by(ArrivalPlan.date, ArrivalPlan.dormitory_id)
    )
    if dormitory_ids is not None:
        statement = statement.where(ArrivalPlan.dormitory_id.in_(dormitory_ids))
    return [plan_response(plan) for plan in db.scalars(statement)]


def report_arrivals(db: Session, dormitory_id: int, start: date, end: date) -> dict[date, int]:
    # ФИО не определяют количество. Архивирование общежития не меняет его прошлые отчёты.
    return {
        plan.date: plan.count
        for plan in db.scalars(
            select(ArrivalPlan).where(
                ArrivalPlan.dormitory_id == dormitory_id,
                ArrivalPlan.date >= start,
                ArrivalPlan.date <= end,
            )
        )
    }
