"""Подтверждённые выселения в списке закончивших вахту."""

from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.models.outflow import PersonnelOutflow
from app.models.personnel import Employee, normalized_name
from app.models.table_column import TableColumn
from app.schemas.personnel import FinishedShift
from app.table_pagination import PageRequest, TablePage, page_items

MOSCOW = ZoneInfo("Europe/Moscow")
NOTE_NAMES = {"примечание", "примечания", "доп. информация", "дополнительная информация"}


def departure_day(row: PersonnelOutflow) -> date:
    if row.departure_date is not None:
        return row.departure_date
    confirmed = row.evicted_at
    assert confirmed is not None
    if confirmed.tzinfo is None:
        confirmed = confirmed.replace(tzinfo=UTC)
    return confirmed.astimezone(MOSCOW).date()


def finished_shifts(
    db: Session,
    dormitory_ids: Sequence[int],
    start: date,
    end: date,
    paging: PageRequest,
) -> TablePage[FinishedShift]:
    row = PersonnelOutflow
    start_time = datetime.combine(start, time.min, tzinfo=MOSCOW).astimezone(UTC)
    end_time = datetime.combine(end, time.max, tzinfo=MOSCOW).astimezone(UTC)
    query = (
        select(row, Employee)
        .join(Employee, Employee.id == row.employee_id)
        .where(
            row.dormitory_id.in_(dormitory_ids),
            row.evicted_at.is_not(None),
            or_(
                row.departure_date.between(start, end),
                and_(row.departure_date.is_(None), row.evicted_at.between(start_time, end_time)),
            ),
        )
    )
    records = sorted(
        db.execute(query).tuples(),
        key=lambda item: (departure_day(item[0]), item[0].id),
        reverse=True,
    )
    page = page_items(
        records,
        paging,
        ranks={},
        row_key=lambda item: str(item[0].id),
        search=lambda item: (
            item[0].full_name,
            item[0].personnel_number,
            item[1].full_name,
            item[1].personnel_number,
            item[1].phone,
        ),
        size=20,
    )
    note_columns: dict[int, list[str]] = defaultdict(list)
    if page.rows:
        columns = db.scalars(
            select(TableColumn)
            .where(
                TableColumn.dormitory_id.in_({entry.dormitory_id for entry, _ in page.rows}),
                TableColumn.table_key == "outflow",
                TableColumn.builtin_key.is_(None),
                TableColumn.kind == "text",
            )
            .order_by(TableColumn.position, TableColumn.id)
        )
        for column in columns:
            if normalized_name(column.name) in NOTE_NAMES:
                note_columns[column.dormitory_id].append(str(column.id))

    def render(item: tuple[PersonnelOutflow, Employee]) -> FinishedShift:
        entry, person = item
        notes = [
            entry.notes,
            entry.additional_info,
            *(entry.custom_values.get(key) for key in note_columns[entry.dormitory_id]),
        ]
        distinct_notes = dict.fromkeys(
            note.strip() for note in notes if isinstance(note, str) and note.strip()
        )
        return FinishedShift(
            id=entry.id,
            employee_id=person.id,
            full_name=entry.full_name or person.full_name,
            dormitory_id=entry.dormitory_id,
            departure_date=departure_day(entry),
            notes="\n".join(distinct_notes) or None,
        )

    return page.response(render)
