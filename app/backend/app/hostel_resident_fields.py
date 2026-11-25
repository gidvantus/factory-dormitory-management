"""Изменения состава хостелов по значениям столбцов «Проживающих»."""

from collections import Counter, defaultdict
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from hashlib import sha256
from typing import Any
from typing import cast as type_cast

from sqlalchemy import Date, case, cast, event, insert, inspect, null, select, update
from sqlalchemy.orm import Session

from app import hostel_occupancy
from app.models.hostel import Hostel, HostelOccupancyChange
from app.models.resident import Resident
from app.models.table_column import TableColumn

BUILTIN_FIELDS = (
    "gender",
    "personnel_number",
    "full_name",
    "shift_start",
    "shift_count",
    "shift_end",
    "phone",
    "medical_book",
    "notes",
)
ResidentFields = dict[str, Any]
Histogram = dict[str, Counter[str]]
_PRIOR_FIELDS = "hostel_occupancy_previous_fields"
_EFFECTIVE_DAY = "hostel_occupancy_effective_day"


def field_key(column: TableColumn) -> str:
    return column.builtin_key or str(column.id)


def fingerprint(value: object) -> str | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        value = format(Decimal(str(value)).normalize(), "f")
    return sha256(str(value).encode("utf-8")).hexdigest()


def resident_fields(builtin: Iterable[Any], custom: dict[str, Any] | None) -> ResidentFields:
    return {**(custom or {}), **dict(zip(BUILTIN_FIELDS, builtin, strict=True))}


def set_occupancy_day(resident: Resident, day: date | None) -> None:
    if day is not None:
        inspect(resident).info[_EFFECTIVE_DAY] = day


@event.listens_for(Session, "before_flush")
def capture_resident_fields(session: Session, _context: object, _instances: object) -> None:
    session.info.pop(_PRIOR_FIELDS, None)
    ids = [
        row.id
        for row in session.dirty | session.deleted
        if isinstance(row, Resident)
        and (
            row in session.deleted
            or any(
                inspect(row).attrs[key].history.has_changes()
                for key in ("hostel_id", "custom_values", *BUILTIN_FIELDS)
            )
        )
    ]
    if not ids:
        return
    previous: dict[int, tuple[int | None, ResidentFields]] = {}
    for ident, hostel_id, custom, *values in session.execute(
        select(
            Resident.id,
            Resident.hostel_id,
            Resident.custom_values,
            *(getattr(Resident, key) for key in BUILTIN_FIELDS),
        ).where(Resident.id.in_(ids))
    ):
        assert isinstance(ident, int)
        assert hostel_id is None or isinstance(hostel_id, int)
        previous[ident] = (hostel_id, resident_fields(values, type_cast(ResidentFields, custom)))
    session.info[_PRIOR_FIELDS] = previous


def field_changes(before: ResidentFields, after: ResidentFields) -> dict[str, dict[str, int]]:
    # Для сравнения достаточно хешей, исходные значения личных полей не сохраняются.
    changes = {}
    for key in before.keys() | after.keys():
        old, new = fingerprint(before.get(key)), fingerprint(after.get(key))
        if old != new:
            changes[key] = {
                value: direction for value, direction in ((old, -1), (new, 1)) if value is not None
            }
    return changes


@event.listens_for(Session, "after_flush")
def record_occupancy_changes(session: Session, _context: object) -> None:
    previous: dict[int, tuple[int | None, ResidentFields]] = session.info.pop(_PRIOR_FIELDS, {})
    residents = [
        row
        for row in session.new | session.dirty | session.deleted
        if isinstance(row, Resident) and (row in session.new or row.id in previous)
    ]
    if not residents:
        return
    today = hostel_occupancy.occupancy_today()
    departures: dict[date, list[int]] = defaultdict(list)
    entries = []
    for resident in residents:
        old_hostel, old = previous.get(resident.id, (None, {}))
        deleted = resident in session.deleted
        new_hostel = None if deleted else resident.hostel_id
        new = (
            resident_fields(
                (getattr(resident, key) for key in BUILTIN_FIELDS), resident.custom_values
            )
            if new_hostel is not None
            else {}
        )
        day = min(inspect(resident).info.pop(_EFFECTIVE_DAY, today), today)
        if deleted:
            departures[day].append(resident.id)
        for hostel_id in {old_hostel, new_hostel} - {None}:
            before = old if old_hostel == hostel_id else {}
            after = new if new_hostel == hostel_id else {}
            total = int(new_hostel == hostel_id) - int(old_hostel == hostel_id)
            men = int(after.get("gender") == "М") - int(before.get("gender") == "М")
            women = int(after.get("gender") == "Ж") - int(before.get("gender") == "Ж")
            fields = field_changes(before, after)
            if total or men or women or fields:
                entries.append(
                    {
                        "hostel_id": hostel_id,
                        "resident_id": None if deleted else resident.id,
                        "day": day,
                        "men": men,
                        "women": women,
                        "total": total,
                        "fields": fields,
                    }
                )
    for day, ids in departures.items():
        # Переводы и правки после фактического выезда схлопываются в день выезда.
        # Обнуление ссылки отделяет завершённое проживание от новых записей.
        session.execute(
            update(HostelOccupancyChange)
            .where(HostelOccupancyChange.resident_id.in_(ids))
            .values(
                resident_id=None,
                day=case((HostelOccupancyChange.day > day, day), else_=HostelOccupancyChange.day),
            )
            .execution_options(synchronize_session=False)
        )
    if entries:
        session.execute(insert(HostelOccupancyChange), entries)


def filtered_occupancy(
    db: Session,
    hostels: Iterable[Hostel],
    days: list[date],
    fields_by_hostel: dict[int, set[str]],
) -> dict[tuple[int, date], Histogram]:
    wanted = {hostel.id: hostel for hostel in hostels if fields_by_hostel.get(hostel.id)}
    today = hostel_occupancy.occupancy_today()
    days = sorted((day for day in days if day <= today), reverse=True)
    if not wanted or not days:
        return {}
    current: dict[int, Histogram] = defaultdict(lambda: defaultdict(Counter))
    changes: dict[int, list[tuple[date, Histogram]]] = defaultdict(list)
    # Текущее состояние и его изменения должны читаться в одном SQL-снимке.
    builtin = [getattr(Resident, key) for key in BUILTIN_FIELDS]
    rows = db.execute(
        select(
            Resident.hostel_id, cast(null(), Date).label("day"), Resident.custom_values, *builtin
        )
        .where(Resident.hostel_id.in_(wanted))
        .union_all(
            select(
                HostelOccupancyChange.hostel_id,
                HostelOccupancyChange.day,
                HostelOccupancyChange.fields,
                *(cast(null(), item.type) for item in builtin),
            ).where(
                HostelOccupancyChange.hostel_id.in_(wanted),
                HostelOccupancyChange.day > days[-1],
            )
        )
    )
    for hostel_id, day, data, *values in rows:
        assert isinstance(hostel_id, int)
        payload = type_cast(ResidentFields, data)
        keys = fields_by_hostel[hostel_id]
        if day is None:
            values_by_key = resident_fields(values, payload)
            for key in keys:
                if signature := fingerprint(values_by_key.get(key)):
                    current[hostel_id][key][signature] += 1
        elif payload:
            assert isinstance(day, date)
            deltas: Histogram = {key: Counter(payload[key]) for key in keys & payload.keys()}
            if deltas:
                changes[hostel_id].append((day, deltas))
    result: dict[tuple[int, date], Histogram] = {}
    for hostel_id, hostel in wanted.items():
        balance = current[hostel_id]
        later = iter(sorted(changes[hostel_id], key=lambda entry: entry[0], reverse=True))
        change = next(later, None)
        for day in days:
            if day < hostel.resident_fields_since:
                break
            while change and change[0] > day:
                for field, counter_delta in change[1].items():
                    balance[field].subtract(counter_delta)
                change = next(later, None)
            result[hostel_id, day] = {field: counter.copy() for field, counter in balance.items()}
    return result
