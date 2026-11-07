"""Сводный отчёт: стабильные строки источников и отдельные значения по общежитиям."""

from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.reports import read_report
from app.models.dormitory import Dormitory
from app.models.report import ReportRow
from app.models.user import User
from app.schemas.dashboard_block import (
    SummaryResult,
    SummaryValue,
    WidgetConfig,
    WidgetDefinition,
    WidgetPoint,
    WidgetResult,
)
from app.section_state import require_section


def normalized_name(value: str) -> str:
    return " ".join(value.lower().replace("ё", "е").split())


def validate_summary(db: Session, config: WidgetConfig, organization_id: int) -> None:
    summary = config.summary
    assert summary is not None
    ids = set(summary.dormitory_ids) | set(config.excluded_dormitory_ids)
    for metric in summary.metrics:
        for source in metric.sources:
            ids.add(source.dormitory_id)
            row = db.get(ReportRow, source.row_id)
            if row is None or row.dormitory_id != source.dormitory_id:
                raise HTTPException(422, "Строка показателя отсутствует в выбранном общежитии")
    owned = set(
        db.scalars(select(Dormitory.id).where(Dormitory.organization_id == organization_id))
    )
    if not ids <= owned:
        raise HTTPException(404, "Общежитие не найдено")


def calculate_summary(
    db: Session,
    user: User,
    block: WidgetDefinition,
    dormitories: list[Dormitory],
    start: date,
    end: date,
) -> WidgetResult:
    config = block.config
    summary = config.summary
    assert summary is not None
    days = [start + timedelta(days=index) for index in range((end - start).days + 1)]
    rows: list[SummaryValue] = []
    errors: list[str] = []
    included = [
        dorm
        for dorm in dormitories
        if not dorm.is_archived
        and dorm.id not in config.excluded_dormitory_ids
        and (config.all_dormitories or dorm.id in summary.dormitory_ids)
    ]
    for dorm in included:
        report = None
        try:
            require_section(db, dorm.id, "report")
            # Отдельный запрос: кэш обычных блоков может заканчиваться датой среза.
            report = read_report(dorm.id, user, db, start, end, dorm)
        except HTTPException:
            errors.append(f"{dorm.name}: общий отчёт недоступен")
        label = dorm.name
        if summary.label == "client":
            label = f"{dorm.client_name or 'Без клиента'} ({dorm.name})"
        for metric in summary.metrics:
            explicit = next(
                (source for source in metric.sources if source.dormitory_id == dorm.id), None
            )
            candidates = (
                [
                    row
                    for row in report.rows
                    if (
                        row.id == explicit.row_id
                        if explicit
                        else normalized_name(row.name) == normalized_name(metric.name)
                    )
                ]
                if report
                else []
            )
            source_row = candidates[0] if len(candidates) == 1 else None
            values: list[Decimal | None] = []
            for day in days:
                raw = source_row.values.get(day.isoformat()) if source_row else None
                try:
                    value = Decimal(raw) if raw is not None else None
                    if value is not None and not value.is_finite():
                        value = None
                    if source_row and day.isoformat() in source_row.errors:
                        value = None
                except (InvalidOperation, ValueError):
                    value = None
                values.append(value)
            total = None
            if metric.aggregate == "last":
                total = values[-1] if values else None
            elif values and all(value is not None for value in values):
                total = sum((value for value in values if value is not None), Decimal(0))
                if metric.aggregate == "average":
                    total /= len(values)
            if source_row is None:
                errors.append(
                    f"{dorm.name}: показатель «{metric.name}» отсутствует или неоднозначен"
                )
            elif any(value is None for value in values):
                errors.append(
                    f"{dorm.name}: «{metric.name}» — есть пропуски или ошибки в дневных значениях"
                )
            rows.append(
                SummaryValue(
                    dormitory_id=dorm.id,
                    label=label,
                    metric=metric.name,
                    aggregate=metric.aggregate,
                    value=float(total) if total is not None else None,
                    daily=[
                        WidgetPoint(date=day, value=float(value) if value is not None else None)
                        for day, value in zip(days, values, strict=True)
                    ],
                )
            )
    if not included:
        errors.append("Нет выбранных действующих общежитий")
    return WidgetResult(
        id=block.id,
        value=None,
        items=[],
        errors=errors,
        summary=SummaryResult(dates=days, rows=rows),
    )
