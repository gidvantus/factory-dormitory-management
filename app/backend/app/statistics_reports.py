"""Реальные расчёты и подбор источников для новых общежитий по актуальному каталогу."""

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.dashboard_blocks import calculate_widget
from app.models.dormitory import Dormitory
from app.models.user import User
from app.schemas.dashboard_block import (
    CatalogDormitory,
    CatalogSource,
    PlaceWidgetSource,
    ReportWidgetSource,
    TableWidgetSource,
    WidgetConfig,
    WidgetDefinition,
    WidgetFilter,
    WidgetSource,
)
from app.schemas.report import ReportResponse
from app.schemas.statistics_report import StatisticsBlock, StatisticsItem, StatisticsResult
from app.schemas.table_column import ColumnResponse
from app.tab_catalog import normalized_name


def unique[T](items: list[T]) -> T | None:
    return items[0] if len(items) == 1 else None


def source_metadata(dorm: CatalogDormitory, source: WidgetSource) -> CatalogSource | None:
    key = source.table_key if isinstance(source, TableWidgetSource) else source.kind
    return next((item for item in dorm.sources if item.key == key), None)


def source_name(name: str) -> str:
    return normalized_name(name.replace(" (скрыта)", ""))


def match_source(
    source: WidgetSource, origin: CatalogDormitory, target: CatalogDormitory
) -> WidgetSource | None:
    metadata = source_metadata(origin, source)
    if metadata is None:
        return None
    if isinstance(source, ReportWidgetSource):
        row = next((item for item in metadata.rows if item["id"] == source.row_id), None)
        destination = next((item for item in target.sources if item.key == "report"), None)
        if row is None or destination is None:
            return None
        matched = unique(
            [
                item
                for item in destination.rows
                if normalized_name(str(item["name"])) == normalized_name(str(row["name"]))
            ]
        )
        return (
            ReportWidgetSource(kind="report", dormitory_id=target.id, row_id=int(matched["id"]))
            if matched
            else None
        )
    if isinstance(source, PlaceWidgetSource):
        destination = next((item for item in target.sources if item.key == "places"), None)
        if destination is None:
            return None
        hostel_id = None
        if source.hostel_id is not None:
            hostel = next(
                (item for item in metadata.hostels if item["id"] == source.hostel_id), None
            )
            matched = unique(
                [
                    item
                    for item in destination.hostels
                    if hostel
                    and normalized_name(str(item["name"])) == normalized_name(str(hostel["name"]))
                ]
            )
            if matched is None:
                return None
            hostel_id = int(matched["id"])
        return PlaceWidgetSource(
            kind="places", dormitory_id=target.id, metric=source.metric, hostel_id=hostel_id
        )
    destination = unique(
        [
            item
            for item in target.sources
            if item.kind == "table"
            and (
                source_name(item.name) == source_name(metadata.name)
                if source.table_key.startswith("custom_")
                else item.key == source.table_key
            )
        ]
    )
    if destination is None:
        return None

    def column(column_id: int | None) -> ColumnResponse | None:
        old = next((item for item in metadata.columns if item.id == column_id), None)
        return unique(
            [
                item
                for item in destination.columns
                if old
                and item.kind == old.kind
                and normalized_name(item.name) == normalized_name(old.name)
            ]
        )

    value_column, date_column = column(source.value_column_id), column(source.date_column_id)
    if (source.value_column_id is not None and value_column is None) or (
        source.date_column_id is not None and date_column is None
    ):
        return None
    filter_value = None
    if source.filter:
        filter_column = column(source.filter.column_id)
        if filter_column is None:
            return None
        value = source.filter.value
        if filter_column.kind == "select" and source.filter.operator == "equals":
            old_column = next(
                item for item in metadata.columns if item.id == source.filter.column_id
            )
            old_option = next((item for item in old_column.options if item["id"] == value), None)
            option = unique(
                [
                    item
                    for item in filter_column.options
                    if old_option
                    and normalized_name(str(item["label"]))
                    == normalized_name(str(old_option["label"]))
                ]
            )
            if option is None:
                return None
            value = option["id"]
        filter_value = WidgetFilter(
            column_id=filter_column.id, operator=source.filter.operator, value=value
        )
    return TableWidgetSource(
        kind="table",
        dormitory_id=target.id,
        table_key=destination.key,
        value_column_id=value_column.id if value_column else None,
        date_column_id=date_column.id if date_column else None,
        filter=filter_value,
    )


def resolved_query(block: StatisticsBlock, catalog: list[CatalogDormitory]) -> WidgetConfig:
    query = block.query.model_copy(deep=True)
    sources = {source.dormitory_id: source for source in query.sources}
    anchor = next(
        (
            source
            for source in query.sources
            if any(
                dorm.id == source.dormitory_id and source_metadata(dorm, source) is not None
                for dorm in catalog
            )
        ),
        None,
    )
    origin = next((dorm for dorm in catalog if anchor and dorm.id == anchor.dormitory_id), None)
    included = [
        dorm
        for dorm in catalog
        if (
            dorm.id not in query.excluded_dormitory_ids
            and (query.all_dormitories or dorm.id in block.selected_dormitory_ids)
        )
    ]
    for dorm in included:
        if dorm.id not in sources and anchor and origin:
            matched = match_source(anchor, origin, dorm)
            if matched:
                sources[dorm.id] = matched
    # Keep missing sources visible to the calculator, which returns null and a precise error.
    query.sources = list(sources.values())
    query.display = "chart"
    query.chart_mode = "dormitories"
    query.grouping = "dormitory"
    query.all_dormitories = True
    # Scope is applied to dormitories below; saved template sources may be outside it.
    query.excluded_dormitory_ids = []
    return query


def aggregate(values: list[float | None], operation: str) -> float | None:
    if not values:
        return None
    if operation == "last":
        return values[-1]
    if any(value is None for value in values):
        return None
    numbers = [Decimal(str(value)) for value in values]
    if operation == "max":
        return float(max(numbers))
    total = sum(numbers, Decimal(0))
    return float(total / len(numbers) if operation == "average" else total)


def calculate_block(
    db: Session,
    user: User,
    block: StatisticsBlock,
    dormitories: list[Dormitory],
    catalog: list[CatalogDormitory],
    start: date,
    end: date | None,
    reports: dict[int, ReportResponse],
) -> StatisticsResult:
    query = resolved_query(block, catalog)
    scoped_dormitories = [
        dorm
        for dorm in dormitories
        if dorm.id not in block.query.excluded_dormitory_ids
        and (block.query.all_dormitories or dorm.id in block.selected_dormitory_ids)
    ]
    result = calculate_widget(
        db, user, WidgetDefinition(id=0, config=query), scoped_dormitories, start, end, reports
    )
    errors = list(result.errors)
    existing = {dorm.id for dorm in catalog}
    if not block.query.all_dormitories and set(block.selected_dormitory_ids) - existing:
        errors.append("Выбранное общежитие удалено. Измените настройки блока.")
        result.daily = [point.model_copy(update={"value": None}) for point in result.daily]
    return StatisticsResult(
        id=block.id,
        value=aggregate([point.value for point in result.daily], block.aggregation),
        daily=result.daily,
        series=result.series,
        errors=errors,
        items=[
            StatisticsItem(
                dormitory_id=series.dormitory_id,
                label=series.label,
                is_archived=series.is_archived,
                value=aggregate([point.value for point in series.daily], block.aggregation),
            )
            for series in result.series
        ],
    )
