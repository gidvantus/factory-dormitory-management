"""Настройки строк и единый расчёт «Размещения персонала»."""

import ast
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal, DecimalException
from functools import lru_cache
from typing import Any, cast

from fastapi import HTTPException
from pydantic import TypeAdapter
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.arrival_plans import report_arrivals
from app.hostel_occupancy import occupancy_by_day
from app.hostel_resident_fields import field_key, filtered_occupancy, fingerprint
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel, HostelCell
from app.models.report import ReportRow
from app.place_values import active_in_month
from app.report_formula import (
    FormulaError,
    calculate_formula,
    compile_formula,
    format_number,
    validate_row_formulas,
)
from app.schemas.hostel import HostelReportLink, HostelRow, HostelTableLink, ResidentsOccupancyLink
from app.schemas.report import ReportRowResponse
from app.schemas.table_column import ArrivalPlanReportLink

DEFAULT_ROWS = (
    HostelRow(key="residents_m", name="Проживает М"),
    HostelRow(key="residents_f", name="Проживает Ж"),
    HostelRow(
        key="residents_total", name="Итого проживает М+Ж", formula="=[Проживает М]+[Проживает Ж]"
    ),
    HostelRow(key="free_m", name="Свободных мест М", formula="=[Оплачено мест М]-[Проживает М]"),
    HostelRow(key="free_f", name="Свободных мест Ж", formula="=[Оплачено мест Ж]-[Проживает Ж]"),
    HostelRow(
        key="free_total",
        name="Свободных мест М+Ж",
        formula="=[Свободных мест М]+[Свободных мест Ж]",
    ),
    HostelRow(key="paid_m", name="Оплачено мест М"),
    HostelRow(key="paid_f", name="Оплачено мест Ж"),
    HostelRow(
        key="paid_total", name="Итого оплачено М+Ж", formula="=[Оплачено мест М]+[Оплачено мест Ж]"
    ),
)
STANDARD_KEYS = frozenset(row.key for row in DEFAULT_ROWS)
MANUAL_KEYS = frozenset(row.key for row in DEFAULT_ROWS if not row.formula)
HISTORICAL_GENDERS = {fingerprint("М"): 0, fingerprint("Ж"): 1}


def rows_for(hostel: Hostel, day: date) -> list[HostelRow]:
    month = day.replace(day=1).isoformat()
    latest = max((key for key in (hostel.layouts or {}) if key <= month), default=None)
    return (
        [HostelRow.model_validate(row) for row in hostel.layouts[latest]]
        if latest is not None
        else list(DEFAULT_ROWS)
    )


def manual_fields(hostel: Hostel, day: date) -> set[str]:
    return {
        row.key for row in rows_for(hostel, day) if not (row.archived or row.formula or row.link)
    }


def report_link_target(db: Session, dormitory_id: int, link: HostelReportLink) -> ReportRow:
    from app.section_state import require_section

    require_section(db, dormitory_id, "report")
    target = db.get(ReportRow, link.row_id)
    if target is None or target.dormitory_id != dormitory_id:
        raise HTTPException(422, "Выберите строку общего отчёта этого общежития")
    return target


def validate_report_target(db: Session, dormitory_id: int, link: HostelReportLink) -> ReportRow:
    target = report_link_target(db, dormitory_id, link)
    rows = {
        row.name: row
        for row in db.scalars(select(ReportRow).where(ReportRow.dormitory_id == dormitory_id))
    }
    pending = [target]
    visited: set[str] = set()
    while pending:
        row = pending.pop()
        if row.name in visited:
            continue
        visited.add(row.name)
        if row.link and row.link.get("table_key") == "places":
            raise HTTPException(
                422, "Выберите строку отчёта без зависимости от размещения персонала"
            )
        if row.formula:
            pending.extend(rows[name] for name in compiled_formula(row.formula)[1] if name in rows)
    return target


def validate_rows(db: Session, dormitory_id: int, rows: list[HostelRow]) -> list[HostelRow]:
    from app.table_data import validate_link

    if len(rows) > 100:
        raise HTTPException(422, "В хостеле может быть до 100 строк вместе с архивными")
    visible = [row for row in rows if not row.archived]
    if not visible:
        raise HTTPException(422, "Оставьте хотя бы одну действующую строку")
    if len({row.key for row in rows}) != len(rows):
        raise HTTPException(422, "Ключи строк должны быть уникальными")
    if any(
        row.key not in STANDARD_KEYS and not re.fullmatch(r"r_[0-9a-f]{20}", row.key)
        for row in rows
    ):
        raise HTTPException(422, "Неизвестный ключ строки")
    if len({row.name.casefold() for row in visible}) != len(visible):
        raise HTTPException(422, "У действующих строк должны быть разные названия")
    try:
        validate_row_formulas({row.name: row.formula for row in visible})
    except (FormulaError, RecursionError) as exc:
        raise HTTPException(422, str(exc)) from exc
    normalized: list[HostelRow] = []
    for row in rows:
        link = row.link
        if not row.archived and isinstance(link, HostelTableLink):
            validated = validate_link(db, dormitory_id, link)
            assert isinstance(validated, HostelTableLink)
            link = validated
        elif not row.archived and isinstance(link, HostelReportLink):
            validate_report_target(db, dormitory_id, link)
        normalized.append(row.model_copy(update={"link": link}))
    return normalized


@dataclass
class PlaceDay:
    values: dict[str, Decimal] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)


@lru_cache(maxsize=512)
def compiled_formula(formula: str) -> tuple[ast.Expression, set[str]]:
    return compile_formula(formula)


def read_place_days(
    db: Session, hostels: Iterable[Hostel], start: date, end: date
) -> dict[tuple[int, date], PlaceDay]:
    from app.api.reports import read_report
    from app.section_state import require_section
    from app.table_data import Record, get_column, linked_counts, records_for, validate_link

    selected = {hostel.id: hostel for hostel in hostels}
    if not selected:
        return {}
    days = [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
    cell_values: dict[tuple[int, date], dict[str, int]] = {}
    for cell in db.scalars(
        select(HostelCell).where(
            HostelCell.hostel_id.in_(selected),
            HostelCell.report_date.between(start, end),
        )
    ):
        cell_values.setdefault((cell.hostel_id, cell.report_date), {})[cell.field] = cell.value
    layouts = {
        (hostel.id, month): [row for row in rows_for(hostel, month) if not row.archived]
        for month in {day.replace(day=1) for day in days}
        for hostel in selected.values()
        if active_in_month(hostel, month)
    }
    tracked: set[int] = set()
    filters: dict[tuple[int, str], tuple[str, str | None]] = {}
    filter_errors: dict[tuple[int, str], str] = {}
    fields: dict[int, set[str]] = {}
    for (hostel_id, _), layout_rows in layouts.items():
        dormitory_id = selected[hostel_id].dormitory_id
        for row in layout_rows:
            if isinstance(row.link, ResidentsOccupancyLink):
                tracked.add(hostel_id)
            if not isinstance(row.link, HostelTableLink) or row.link.count_mode != "snapshot":
                continue
            key = hostel_id, row.link.model_dump_json()
            if key in filters or key in filter_errors:
                continue
            try:
                require_section(db, dormitory_id, "residents")
                rule = validate_link(db, dormitory_id, row.link)
                assert isinstance(rule, HostelTableLink)
                field = field_key(get_column(db, dormitory_id, "residents", rule.column_id))
                value = fingerprint(rule.value) if rule.operator == "equals" else None
                filters[key] = field, value
                fields.setdefault(hostel_id, set()).add(field)
                if field == "gender":
                    tracked.add(hostel_id)
            except HTTPException as exc:
                filter_errors[key] = str(exc.detail)
    occupancy = occupancy_by_day(db, (selected[key] for key in tracked), days)
    filtered = filtered_occupancy(db, selected.values(), days, fields)

    @lru_cache
    def records(dormitory_id: int, table: str) -> list[Record]:
        return records_for(db, dormitory_id, table)

    adapter: TypeAdapter[HostelReportLink | HostelTableLink | ArrivalPlanReportLink] = TypeAdapter(
        cast(Any, HostelReportLink | HostelTableLink | ArrivalPlanReportLink)
    )

    @lru_cache
    def report_values(dormitory_id: int) -> dict[int, ReportRowResponse]:
        dormitory = db.get(Dormitory, dormitory_id)
        assert dormitory is not None
        report = read_report(dormitory_id, None, db, start, end, dormitory, exclude_places=True)
        return {row.id: row for row in report.rows}

    @lru_cache
    def source_values(
        dormitory_id: int, config: str, hostel_id: int | None
    ) -> tuple[dict[date, Decimal], dict[date, str], str | None]:
        try:
            link = adapter.validate_python(json.loads(config))
            if isinstance(link, HostelReportLink):
                target = report_link_target(db, dormitory_id, link)
                row = report_values(dormitory_id).get(target.id)
                if row is None:
                    raise HTTPException(422, "Строка общего отчёта удалена")
                values: dict[date, Decimal] = {}
                errors = {date.fromisoformat(day): error for day, error in row.errors.items()}
                for day, value in row.values.items():
                    try:
                        number = Decimal(value.replace(",", "."))
                        format_number(number)
                        values[date.fromisoformat(day)] = number
                    except (DecimalException, FormulaError):
                        errors[date.fromisoformat(day)] = "В строке отчёта должно быть число"
                return values, errors, None
            counts = (
                report_arrivals(db, dormitory_id, start, end)
                if isinstance(link, ArrivalPlanReportLink)
                else linked_counts(
                    db,
                    dormitory_id,
                    link,
                    records(dormitory_id, link.table_key),
                    start,
                    end,
                    hostel_id=hostel_id,
                )
            )
            return {day: Decimal(value) for day, value in counts.items()}, {}, None
        except (HTTPException, ValueError) as exc:
            return {}, {}, str(exc.detail if isinstance(exc, HTTPException) else exc)

    result: dict[tuple[int, date], PlaceDay] = {}
    for day in days:
        for hostel in selected.values():
            rows = layouts.get((hostel.id, day.replace(day=1)))
            if rows is None:
                continue
            entry = result[(hostel.id, day)] = PlaceDay()
            stored = cell_values.get((hostel.id, day), {})
            inputs: dict[str, Decimal | None] = {}
            for row in rows:
                link = row.link
                if isinstance(link, ResidentsOccupancyLink):
                    counts = occupancy.get((hostel.id, day))
                    if counts is not None:
                        inputs[row.key] = Decimal(counts[{"М": 0, "Ж": 1, "all": 2}[link.gender]])
                    else:
                        # До начала учёта остаются прежние ручные числа.
                        inputs[row.key] = (
                            Decimal(stored[row.key])
                            if day < hostel.occupancy_since and row.key in stored
                            else None
                        )
                elif isinstance(link, HostelTableLink) and link.count_mode == "snapshot":
                    key = hostel.id, link.model_dump_json()
                    if key in filter_errors:
                        entry.errors[row.key] = filter_errors[key]
                        inputs[row.key] = None
                        continue
                    field, signature = filters[key]
                    histogram = filtered.get((hostel.id, day))
                    legacy = occupancy.get((hostel.id, day))
                    if histogram is not None:
                        counter = histogram.get(field)
                        count = 0
                        if counter:
                            count = counter.get(signature, 0) if signature else counter.total()
                        inputs[row.key] = Decimal(count)
                    elif (
                        field == "gender" and legacy is not None and signature in HISTORICAL_GENDERS
                    ):
                        inputs[row.key] = Decimal(legacy[HISTORICAL_GENDERS[signature]])
                    elif field == "gender" and legacy is not None and signature is None:
                        inputs[row.key] = Decimal(legacy[0] + legacy[1])
                    else:
                        inputs[row.key] = (
                            Decimal(stored[row.key])
                            if day < hostel.resident_fields_since and row.key in stored
                            else None
                        )
                elif link:
                    values, errors, error = source_values(
                        hostel.dormitory_id,
                        link.model_dump_json(),
                        hostel.id
                        if isinstance(link, HostelTableLink) and link.scope == "hostel"
                        else None,
                    )
                    if problem := error or errors.get(day):
                        entry.errors[row.key] = problem
                    inputs[row.key] = values.get(
                        day, Decimal(0) if not isinstance(link, HostelReportLink) else None
                    )
                elif row.formula is None:
                    inputs[row.key] = Decimal(stored[row.key]) if row.key in stored else None
            calculate_day(rows, inputs, entry)
    return result


def calculate_day(
    rows: list[HostelRow], inputs: dict[str, Decimal | None], entry: PlaceDay
) -> None:
    names = {row.name: row for row in rows}
    cache = dict(inputs)
    active: set[str] = set()

    def read(row: HostelRow) -> Decimal | None:
        if error := entry.errors.get(row.key):
            raise FormulaError(error)
        if row.key in cache:
            return cache[row.key]
        if row.key in active:
            raise FormulaError("Формулы не могут ссылаться друг на друга по кругу")
        assert row.formula is not None
        expression, refs = compiled_formula(row.formula)
        active.add(row.key)
        try:
            numbers = {name: read(names[name]) for name in refs}
            value = (
                None
                if refs and all(value is None for value in numbers.values())
                else calculate_formula(expression, lambda name: numbers[name] or Decimal(0))
            )
            if value is not None:
                format_number(value)
            cache[row.key] = value
            return value
        finally:
            active.remove(row.key)

    for row in rows:
        try:
            if (value := read(row)) is not None:
                entry.values[row.key] = value
        except KeyError as exc:
            entry.errors[row.key] = f"Строка не найдена: {exc.args[0]}"
        except (FormulaError, DecimalException, RecursionError) as exc:
            entry.errors[row.key] = str(exc)


def display_number(value: Decimal) -> int | str:
    return int(value) if value == value.to_integral_value() else format_number(value)
