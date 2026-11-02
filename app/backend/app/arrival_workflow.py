"""Атомарные отметки, перенос и оформление одного человека из плана заездов."""

from copy import deepcopy
from datetime import UTC, datetime
from datetime import date as CalendarDate
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.arrival_settings import defaults, effective_people
from app.models.arrival_plan import ArrivalPlan, ArrivalSettings, ArrivalVisit
from app.models.hostel import Hostel
from app.models.resident import Resident
from app.personnel import (
    choose_identity,
    employee_in_scope,
    event,
    fulfill_arrival,
    group_ids,
    identity_lock,
    normalized,
    record_changed,
    today,
)
from app.schemas.arrival_workflow import VisitSettle
from app.table_data import require_writable_table


def person_of(plan: ArrivalPlan, person_id: str) -> dict[str, Any]:
    person = next((person for person in effective_people(plan) if person["id"] == person_id), None)
    if person is None:
        raise HTTPException(404, "Человек в плане заезда не найден")
    return person


def visit_of(plan: ArrivalPlan, person_id: str) -> ArrivalVisit | None:
    return next((visit for visit in plan.visits if visit.person_id == person_id), None)


def new_visit(plan: ArrivalPlan, person_id: str, lineage: str | None = None) -> ArrivalVisit:
    person = person_of(plan, person_id)
    if not person["full_name"].strip():
        raise HTTPException(422, "Сначала заполните ФИО человека в плане заезда")
    id = str(uuid4())
    visit = ArrivalVisit(
        id=id, person_id=person_id, lineage_id=lineage or id, status="expected", history=[]
    )
    plan.visits.append(visit)
    return visit


def check_revision(plan: ArrivalPlan, revision: int) -> None:
    if plan.revision != revision:
        raise HTTPException(409, "План уже изменён. Обновите запись перед действием.")


def history(visit: ArrivalVisit, action: str, actor_id: int, **values: Any) -> None:
    visit.history = [
        *visit.history,
        {
            "action": action,
            "at": datetime.now(UTC).isoformat(),
            "date": today().isoformat(),
            "actor_id": actor_id,
            **values,
        },
    ]


def mark(plan: ArrivalPlan, person_id: str, status: str, revision: int, actor_id: int) -> None:
    person_of(plan, person_id)
    visit = visit_of(plan, person_id)
    if visit and visit.status == status:
        return
    check_revision(plan, revision)
    if visit and visit.status in ("moved", "settled"):
        raise HTTPException(409, "Для этой записи уже выполнен перенос или оформлено проживание")
    if status != "expected" and visit and visit.status != "expected":
        raise HTTPException(409, "Сначала верните человека в ожидаемые")
    visit = visit or new_visit(plan, person_id)
    visit.status = status
    visit.arrived_on = today() if status == "arrived" else None
    history(visit, status, actor_id)
    plan.revision += 1


def ref(plan: ArrivalPlan, person_id: str) -> dict[str, Any]:
    return {
        "plan_id": plan.id,
        "person_id": person_id,
        "date": plan.date.isoformat(),
        "dormitory_id": plan.dormitory_id,
    }


def move(
    db: Session, plan: ArrivalPlan, person_id: str, date: CalendarDate, revision: int, actor_id: int
) -> ArrivalPlan:
    person = person_of(plan, person_id)
    visit = visit_of(plan, person_id)
    if (
        visit
        and visit.status == "moved"
        and visit.destination
        and visit.destination["date"] == date.isoformat()
    ):
        target = db.get(ArrivalPlan, visit.destination["plan_id"])
        if target is not None:
            return target
    check_revision(plan, revision)
    if date == plan.date:
        raise HTTPException(422, "Выберите другую дату заезда")
    if visit and visit.status not in ("expected", "no_show"):
        raise HTTPException(409, "Перенести можно человека, который ещё не прибыл")
    target = db.scalar(
        select(ArrivalPlan)
        .where(ArrivalPlan.dormitory_id == plan.dormitory_id, ArrivalPlan.date == date)
        .with_for_update()
    )
    visit = visit or new_visit(plan, person_id)
    if target is None:
        target = ArrivalPlan(
            id=str(uuid4()),
            dormitory_id=plan.dormitory_id,
            date=date,
            count=1,
            names=[],
            people=[],
            custom_values=deepcopy(plan.custom_values),
            revision=0,
        )
        db.add(target)
        target_people: list[dict[str, Any]] = []
    else:
        if target.count >= 10000:
            raise HTTPException(422, "В целевом заезде уже 10 000 человек")
        if any(item.lineage_id == visit.lineage_id for item in target.visits):
            raise HTTPException(
                409, "Этот человек уже есть в выбранном дне. Проверьте его предыдущий перенос."
            )
        target_people = deepcopy(effective_people(target))
        target.revision += 1
    new_person_id = str(uuid4())
    target_people.append({**deepcopy(person), "id": new_person_id})
    target.people = target_people
    target.count = len(target_people)
    target.names = [item["full_name"] for item in target_people if item["full_name"]]
    destination = new_visit(target, new_person_id, visit.lineage_id)
    destination.origin = ref(plan, person_id)
    history(destination, "rescheduled_from", actor_id, origin=destination.origin)
    visit.previous_status = visit.status
    visit.status = "moved"
    visit.destination = ref(target, new_person_id)
    history(visit, "moved", actor_id, destination=visit.destination)
    plan.revision += 1
    return target


def undo_move(
    db: Session, plan: ArrivalPlan, person_id: str, revision: int, actor_id: int
) -> tuple[ArrivalPlan, bool]:
    check_revision(plan, revision)
    visit = visit_of(plan, person_id)
    if visit is None or visit.status != "moved" or not visit.destination:
        raise HTTPException(409, "У этой записи нет действующего переноса")
    target = db.get(ArrivalPlan, visit.destination["plan_id"])
    destination = visit_of(target, visit.destination["person_id"]) if target else None
    if target is None or destination is None or destination.status != "expected":
        raise HTTPException(409, "В новой дате уже выполнено действие. Отменить перенос нельзя.")
    target_person = person_of(target, destination.person_id)
    plan.people = [
        deepcopy(target_person) | {"id": person_id} if item["id"] == person_id else item
        for item in effective_people(plan)
    ]
    plan.names = [item["full_name"] for item in plan.people if item["full_name"]]
    target.people = [
        item for item in effective_people(target) if item["id"] != destination.person_id
    ]
    target.names = [item["full_name"] for item in target.people if item["full_name"]]
    target.visits.remove(destination)
    visit.status = visit.previous_status or "expected"
    history(
        visit,
        "undo_move",
        actor_id,
        destination=visit.destination,
        destination_history=destination.history,
    )
    visit.destination = None
    visit.previous_status = None
    plan.revision += 1
    if target.people:
        target.count = len(target.people)
        target.revision += 1
        return target, False
    db.delete(target)
    return target, True


def guard_edit(plan: ArrivalPlan, values: dict[str, Any]) -> None:
    if not plan.visits:
        return
    if values["date"] != plan.date or values["dormitory_id"] != plan.dormitory_id:
        raise HTTPException(
            409, "В заезде уже есть отметки. Переносите каждого человека отдельным действием."
        )
    old = {person["id"]: person for person in effective_people(plan)}
    new = {person["id"]: person for person in values["people"]}
    for visit in plan.visits:
        before, after = old.get(visit.person_id), new.get(visit.person_id)
        if not after or not before or after["full_name"] != before["full_name"]:
            raise HTTPException(
                409,
                "Нельзя удалить или заменить человека с отметками. Его история должна сохраниться.",
            )
        if visit.status in ("moved", "settled") and before != after:
            raise HTTPException(
                409, "Сведения перенесённого или заселённого человека доступны в связанной записи."
            )


def settle(
    db: Session,
    plan: ArrivalPlan,
    person_id: str,
    payload: VisitSettle,
    config: ArrivalSettings | None,
    dormitory_ids: list[int],
    actor_id: int,
) -> ArrivalVisit:
    person = person_of(plan, person_id)
    visit = visit_of(plan, person_id)
    if visit and visit.status == "settled":
        return visit
    check_revision(plan, payload.revision)
    if visit is None or visit.status != "arrived":
        raise HTTPException(409, "Сначала отметьте прибытие человека")
    if normalized("full_name", payload.identity.full_name) != normalized(
        "full_name", person["full_name"]
    ):
        raise HTTPException(422, "ФИО должно соответствовать выбранному человеку в плане заезда")
    require_writable_table(db, plan.dormitory_id, "residents")
    hostel = db.get(Hostel, payload.hostel_id)
    month = payload.settlement_date.replace(day=1)
    if (
        hostel is None
        or hostel.dormitory_id != plan.dormitory_id
        or hostel.active_from_month > month
        or (hostel.active_until_month and hostel.active_until_month <= month)
    ):
        raise HTTPException(422, "Выбранный хостел не действует в месяце заселения")
    identity_lock(db)
    if payload.identity.mode == "existing":
        employee_in_scope(db, str(payload.identity.employee_id), dormitory_ids)
    employee = choose_identity(db, payload.identity, dormitory_ids)
    ids = group_ids(db, employee.id)
    number = payload.identity.personnel_number or employee.personnel_number
    residents = list(db.scalars(select(Resident).where(Resident.dormitory_id.in_(dormitory_ids))))
    if any(
        row.employee_id in ids
        or (
            number
            and normalized("personnel_number", row.personnel_number)
            == normalized("personnel_number", number)
        )
        for row in residents
    ):
        raise HTTPException(
            409,
            "У сотрудника или этого табельного номера уже есть действующее проживание. "
            "Откройте существующую запись.",
        )
    fields = [
        *(config.settings if config else defaults())["fields"],
        *((config.retired_fields or {}).values() if config else []),
    ]
    snapshot = {
        "full_name": person["full_name"],
        "hostel_name": hostel.name,
        "settlement_date": payload.settlement_date.isoformat(),
        "shift_start": payload.shift_start.isoformat(),
        "shift_end": payload.shift_end.isoformat() if payload.shift_end else None,
        "shift_count": payload.shift_count,
        "fields": deepcopy(fields),
        "personal_values": deepcopy(person["custom_values"]),
        "arrival_values": deepcopy(plan.custom_values),
        "source": ref(plan, person_id),
    }
    notes = []
    for field in fields:
        value = (
            snapshot["personal_values"]
            if field["scope"] == "person"
            else snapshot["arrival_values"]
        ).get(field["id"])
        if value is not None and value != "":
            printed = "Да" if value is True else "Нет" if value is False else str(value)
            notes.append(f"{field['label']}: {printed}")
    row = Resident(
        dormitory_id=plan.dormitory_id,
        employee_id=employee.id,
        full_name=person["full_name"],
        personnel_number=number,
        phone=payload.identity.phone or employee.phone,
        hostel_id=hostel.id,
        shift_start=payload.shift_start,
        shift_end=payload.shift_end,
        shift_count=payload.shift_count,
        notes="; ".join(notes)[:5000] or None,
    )
    db.add(row)
    db.flush()
    record_changed(db, row, actor_id)
    fulfill_arrival(db, row, actor_id)
    event(
        db,
        employee.id,
        "arrival",
        "Заселение из плана заездов",
        actor_id,
        dormitory_id=plan.dormitory_id,
        source_table="residents",
        source_id=row.id,
        snapshot=snapshot,
        happened_on=payload.settlement_date,
    )
    visit.status = "settled"
    visit.employee_id = employee.id
    visit.resident_id = row.id
    visit.resident = row
    visit.settlement = snapshot
    history(
        visit,
        "settled",
        actor_id,
        resident_id=row.id,
        settlement_date=payload.settlement_date.isoformat(),
    )
    plan.revision += 1
    return visit
