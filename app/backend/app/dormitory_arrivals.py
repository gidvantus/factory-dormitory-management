"""Живое представление плана заездов без копирования людей в записи вкладки."""

from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.arrival_settings import active_people, defaults
from app.models.arrival_plan import ArrivalPlan, ArrivalSettings
from app.personnel import today

STATUS_LABELS = {
    "expected": "Ожидается",
    "arrived": "Прибыл",
    "settled": "Прибыл",
    "no_show": "Не приехал",
    "moved": "Перенесён",
}


def source_fields(db: Session, organization_id: int) -> list[dict[str, str]]:
    row = db.get(ArrivalSettings, organization_id)
    settings = row.settings if row else defaults()
    return [
        {"id": "full_name", "label": "ФИО", "kind": "text"},
        {"id": "date", "label": "Дата заезда", "kind": "date"},
        {"id": "status", "label": "Статус", "kind": "text"},
        *[
            {
                "id": field["scope"] + ":" + field["id"],
                "label": field["label"],
                "kind": field["type"],
            }
            for field in settings["fields"]
        ],
    ]


def arrival_rows(
    db: Session,
    dormitory_id: int,
    mapping: dict[str, str],
    start: date | None = None,
    end: date | None = None,
) -> list[dict[str, Any]]:
    current = today()
    start = start or current
    end = end or (start + timedelta(days=365))
    plans = db.scalars(
        select(ArrivalPlan)
        .where(
            ArrivalPlan.dormitory_id == dormitory_id,
            ArrivalPlan.date >= start,
            ArrivalPlan.date <= end,
        )
        .options(selectinload(ArrivalPlan.visits))
        .order_by(ArrivalPlan.date, ArrivalPlan.id)
    )
    result = []
    for plan in plans:
        visits = {visit.person_id: visit for visit in plan.visits}
        for person in active_people(plan):
            visit = visits.get(person["id"])
            values = {
                "full_name": person["full_name"],
                "date": plan.date.isoformat(),
                "status": STATUS_LABELS.get(visit.status if visit else "expected", "Ожидается"),
                **{"arrival:" + key: value for key, value in (plan.custom_values or {}).items()},
                **{
                    "person:" + key: value for key, value in person.get("custom_values", {}).items()
                },
            }
            result.append(
                {
                    "id": plan.id + ":" + person["id"],
                    "date": plan.date.isoformat(),
                    "custom_values": {
                        column: values.get(field) for column, field in mapping.items()
                    },
                }
            )
    # Ближайшие будущие заезды выше; прошедшие доступны при выборе периода.
    result.sort(
        key=lambda item: (
            item["date"] < current.isoformat(),
            item["date"]
            if item["date"] >= current.isoformat()
            else -date.fromisoformat(item["date"]).toordinal(),
        )
    )
    return result
