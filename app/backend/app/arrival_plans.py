"""Общие данные плана заездов и источника общего отчёта."""

from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.arrival_settings import effective_people
from app.models.arrival_plan import ArrivalPlan, ArrivalVisit
from app.models.dormitory import Dormitory


def plan_response(plan: ArrivalPlan) -> dict[str, Any]:
    return {
        "id": plan.id,
        "dormitory_id": plan.dormitory_id,
        "date": plan.date,
        "count": plan.count,
        "names": plan.names,
        "people": effective_people(plan),
        "custom_values": plan.custom_values or {},
        "revision": plan.revision,
        "workflow": {
            visit.person_id: {
                "status": visit.status,
                "arrived_on": visit.arrived_on,
                "origin": visit.origin,
                "destination": visit.destination,
                "history": visit.history,
                "settlement": visit.settlement,
                "employee_id": visit.employee_id,
                "resident": {"id": visit.resident.id, "dormitory_id": visit.resident.dormitory_id}
                if visit.resident
                else None,
            }
            for visit in plan.visits
        },
    }


def active_arrivals(
    db: Session, dormitory_ids: list[int], start: date | None = None, end: date | None = None
) -> list[dict[str, Any]]:
    """Планы заездов по действующим общежитиям области `dormitory_ids`.

    Область обязательна: `None` здесь означал бы «все общежития всех
    организаций», а такой выборки у кабинета быть не должно.
    """
    statement = (
        select(ArrivalPlan)
        .join(Dormitory)
        .where(
            Dormitory.is_archived.is_(False),
            ArrivalPlan.dormitory_id.in_(dormitory_ids),
        )
        .order_by(ArrivalPlan.date, ArrivalPlan.dormitory_id)
    )
    if start is not None:
        statement = statement.where(ArrivalPlan.date >= start)
    if end is not None:
        statement = statement.where(ArrivalPlan.date <= end)
    return [plan_response(plan) for plan in db.scalars(statement)]


def report_arrivals(db: Session, dormitory_id: int, start: date, end: date) -> dict[date, int]:
    # Считаем и безымянные строки. Перенос и неявка исключаются; снимки людей не загружаем.
    excluded = (
        select(ArrivalVisit.plan_id, func.count().label("count"))
        .where(ArrivalVisit.status.in_(("moved", "no_show")))
        .group_by(ArrivalVisit.plan_id)
        .subquery()
    )
    rows = db.execute(
        select(ArrivalPlan.date, ArrivalPlan.count - func.coalesce(excluded.c.count, 0))
        .outerjoin(excluded, excluded.c.plan_id == ArrivalPlan.id)
        .where(
            ArrivalPlan.dormitory_id == dormitory_id,
            ArrivalPlan.date >= start,
            ArrivalPlan.date <= end,
        )
    )
    return dict(rows.tuples().all())
