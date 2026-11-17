"""История изменения численности по хостелам без хранения персональных данных."""

from collections import defaultdict
from collections.abc import Iterable
from datetime import date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import Date, cast, event, func, inspect, null, select
from sqlalchemy.orm import Session

from app.models.hostel import Hostel, HostelOccupancyChange
from app.models.resident import Resident

Counts = tuple[int, int, int]
EMPTY: Counts = (0, 0, 0)


def occupancy_today() -> date:
    return datetime.now(ZoneInfo("Europe/Moscow")).date()


def count_gender(gender: str | None) -> Counts:
    return int(gender == "М"), int(gender == "Ж"), 1


@event.listens_for(Session, "after_flush")
def record_occupancy_changes(session: Session, _flush_context: object) -> None:
    changes: dict[int, list[int]] = defaultdict(lambda: [0, 0, 0])

    def add(hostel_id: int | None, gender: str | None, direction: int) -> None:
        if hostel_id is not None:
            for index, count in enumerate(count_gender(gender)):
                changes[hostel_id][index] += direction * count

    for row in session.new | session.dirty | session.deleted:
        if not isinstance(row, Resident):
            continue
        state = inspect(row)
        hostel = state.attrs.hostel_id.history
        gender = state.attrs.gender.history
        if row in session.new:
            add(row.hostel_id, row.gender, 1)
        elif row in session.deleted or hostel.has_changes() or gender.has_changes():
            add(
                hostel.deleted[0] if hostel.deleted else row.hostel_id,
                gender.deleted[0] if gender.deleted else row.gender,
                -1,
            )
            if row not in session.deleted:
                add(row.hostel_id, row.gender, 1)
    if changes:
        day = occupancy_today()
        session.add_all(
            HostelOccupancyChange(hostel_id=key, day=day, men=men, women=women, total=total)
            for key, (men, women, total) in changes.items()
            if men or women or total
        )


def occupancy_by_day(
    db: Session, hostels: Iterable[Hostel], days: list[date]
) -> dict[tuple[int, date], Counts]:
    selected = {hostel.id: hostel for hostel in hostels}
    today = occupancy_today()
    requested = [day for day in days if day <= today]
    if not selected or not requested:
        return {}
    current: dict[int, list[int]] = defaultdict(lambda: [0, 0, 0])
    # Численность и изменения читаются в одном SQL-снимке даже при READ COMMITTED.
    present = (
        select(
            Resident.hostel_id.label("hostel_id"),
            func.count().filter(Resident.gender == "М").label("men"),
            func.count().filter(Resident.gender == "Ж").label("women"),
            func.count().label("total"),
        )
        .where(Resident.hostel_id.in_(selected))
        .group_by(Resident.hostel_id)
        .subquery()
    )
    changes = db.execute(
        select(
            present.c.hostel_id,
            cast(null(), Date).label("day"),
            present.c.men,
            present.c.women,
            present.c.total,
        ).union_all(
            select(
                HostelOccupancyChange.hostel_id,
                HostelOccupancyChange.day,
                func.sum(HostelOccupancyChange.men),
                func.sum(HostelOccupancyChange.women),
                func.sum(HostelOccupancyChange.total),
            )
            .where(
                HostelOccupancyChange.hostel_id.in_(selected),
                HostelOccupancyChange.day > min(requested),
            )
            .group_by(HostelOccupancyChange.hostel_id, HostelOccupancyChange.day)
        )
    )
    by_hostel: dict[int, list[tuple[date, Counts]]] = defaultdict(list)
    for hostel_id, day, men, women, total in changes:
        assert isinstance(hostel_id, int)
        assert isinstance(men, int) and isinstance(women, int) and isinstance(total, int)
        if day is None:
            current[hostel_id] = [men, women, total]
        else:
            assert isinstance(day, date)
            by_hostel[hostel_id].append((day, (men, women, total)))
    result: dict[tuple[int, date], Counts] = {}
    for hostel_id, hostel in selected.items():
        balance = current[hostel_id]
        later = sorted(by_hostel[hostel_id], reverse=True)
        cursor = 0
        for day in sorted(requested, reverse=True):
            if day < hostel.occupancy_since:
                break
            while cursor < len(later) and later[cursor][0] > day:
                for index, count in enumerate(later[cursor][1]):
                    balance[index] -= count
                cursor += 1
            result[hostel_id, day] = balance[0], balance[1], balance[2]
    return result
