"""Источники и расчёт пользовательских блоков; отсутствие данных не равно нулю."""

from datetime import UTC, date, timedelta
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.reports import read_report
from app.arrival_plans import report_arrivals
from app.models.custom_tab import CustomTab
from app.models.dashboard_block import DEFAULT_DASHBOARD_ORDER, DashboardBlock, DashboardLayout
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel, HostelCell
from app.models.report import ReportRow
from app.models.table_column import TableColumn
from app.models.user import User
from app.place_values import active_in_month, place_day_values
from app.schemas.dashboard_block import (
    ArrivalPlanWidgetSource,
    CatalogDormitory,
    CatalogSource,
    LayoutResponse,
    PlaceWidgetSource,
    ReportWidgetSource,
    TableWidgetSource,
    WidgetConfig,
    WidgetDefinition,
    WidgetPoint,
    WidgetResult,
    WidgetSeries,
    WidgetSource,
    WidgetValue,
)
from app.schemas.report import ReportResponse
from app.schemas.table_column import ColumnResponse
from app.section_state import SECTIONS, require_section, section_ancestors, section_status
from app.table_data import (
    DEFAULT_COLUMNS,
    ensure_columns,
    get_column,
    get_custom_tab,
    normalize_value,
    record_value,
    records_for,
)


def layout_row(db: Session, organization_id: int, *, lock: bool = False) -> DashboardLayout:
    """Раскладка организации; отсутствующая создаётся с порядком по умолчанию.

    `organization_id` обязателен намеренно: у раскладки без организации нет
    владельца, и `== None` вместо `IS NULL` открыл бы её первой же организации.
    """
    query = select(DashboardLayout).where(DashboardLayout.organization_id == organization_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    item = db.scalar(query)
    if item is None:
        # Production migrations seed one row per organization; metadata-only test
        # databases do not, поэтому раскладка заводится здесь.
        item = DashboardLayout(organization_id=organization_id)
        db.add(item)
        db.flush()
    return item


def layout_response(
    db: Session, organization_id: int, layout: DashboardLayout | None = None
) -> LayoutResponse:
    """Раскладка организации и **только её** пользовательские блоки."""
    layout = layout or layout_row(db, organization_id)
    blocks = list(
        db.scalars(
            select(DashboardBlock)
            .where(DashboardBlock.organization_id == organization_id)
            .order_by(DashboardBlock.id)
        )
    )
    keys = [*DEFAULT_DASHBOARD_ORDER, *(f"custom:{block.id}" for block in blocks)]
    order = [key for key in layout.order if key in keys]
    order.extend(key for key in keys if key not in order)
    return LayoutResponse(
        revision=layout.revision,
        order=order,
        hidden=[key for key in layout.hidden if key in keys],
        blocks=[
            WidgetDefinition(id=block.id, config=WidgetConfig.model_validate(block.config))
            for block in blocks
        ],
    )


def check_revision(layout: DashboardLayout, revision: int) -> None:
    if layout.revision != revision:
        raise HTTPException(
            409, "Дашборд уже изменён другим пользователем. Обновите страницу и повторите действие."
        )


def checked_column(
    db: Session, source: TableWidgetSource, column_id: int | None, kind: str | None = None
) -> TableColumn:
    if column_id is None:
        raise HTTPException(422, "Выберите столбец")
    column = get_column(db, source.dormitory_id, source.table_key, column_id)
    if column.archived or column.kind in ("action", "hostel") or (kind and column.kind != kind):
        raise HTTPException(422, f"Столбец «{column.name}» недоступен. Измените источник блока.")
    return column


def validate_source(
    db: Session,
    config: WidgetConfig,
    source: WidgetSource,
    organization_id: int | None = None,
) -> None:
    """Проверить источник блока; с `organization_id` — ещё и принадлежность.

    Принадлежность проверяется там, где конфигурацию присылает клиент
    (`validate_config` передаёт организацию обязательно). При расчёте уже
    сохранённого блока `organization_id` не передаётся намеренно: список
    общежитий там уже отфильтрован по организации, и второй проверки не нужно.
    """
    dormitory = db.get(Dormitory, source.dormitory_id)
    if dormitory is None or (
        organization_id is not None and dormitory.organization_id != organization_id
    ):
        raise HTTPException(404, "Общежитие не найдено")
    if isinstance(source, ArrivalPlanWidgetSource):
        return
    if isinstance(source, ReportWidgetSource):
        require_section(db, source.dormitory_id, "report")
        row = db.get(ReportRow, source.row_id)
        if row is None or row.dormitory_id != source.dormitory_id:
            raise HTTPException(422, "Строка отчёта удалена. Измените источник блока.")
    elif isinstance(source, PlaceWidgetSource):
        require_section(db, source.dormitory_id, "places")
        if source.hostel_id is not None:
            hostel = db.get(Hostel, source.hostel_id)
            if hostel is None or hostel.dormitory_id != source.dormitory_id:
                raise HTTPException(422, "Хостел удалён. Измените источник блока.")
    else:
        if source.table_key.startswith("custom_"):
            get_custom_tab(
                db,
                source.dormitory_id,
                int(source.table_key.removeprefix("custom_")),
                require_table=True,
            )
        else:
            require_section(db, source.dormitory_id, source.table_key)
        if config.operation == "sum":
            checked_column(db, source, source.value_column_id, "number")
        if source.date_column_id is not None:
            checked_column(db, source, source.date_column_id, "date")
        if config.grouping == "value":
            checked_column(db, source, source.group_column_id)
        if source.filter:
            column = checked_column(db, source, source.filter.column_id)
            if source.filter.operator == "equals":
                source.filter.value = normalize_value(
                    column, source.filter.value, allow_archived=True
                )
                if source.filter.value is None:
                    raise HTTPException(422, "Укажите значение условия")


def validate_config(db: Session, config: WidgetConfig, organization_id: int) -> WidgetConfig:
    """Проверить конфигурацию блока, пришедшую от клиента: источники — свои.

    Организация обязательна: `None`, означающий «без ограничения», — ловушка,
    из-за которой проверка принадлежности однажды уже потерялась.
    """
    for source in config.sources:
        validate_source(db, config, source, organization_id)
    return config


def source_catalog(db: Session, organization_id: int) -> list[CatalogDormitory]:
    """Каталог источников: только общежития организации."""
    result = []
    for dorm in db.scalars(
        select(Dormitory).where(Dormitory.organization_id == organization_id).order_by(Dormitory.id)
    ):
        sources = [CatalogSource(key="arrival_plan", name="План заездов", kind="arrival_plan")]

        def exists(key: str, dorm: Dormitory = dorm) -> bool:
            return not any(
                section_status(dorm, item) == "deleted" for item in section_ancestors(dorm, key)
            )

        def label(key: str, dorm: Dormitory = dorm) -> str:
            chain = section_ancestors(dorm, key)
            name = " / ".join(SECTIONS[item] for item in reversed(chain))
            return name + (
                " (скрыта)" if any(section_status(dorm, item) == "hidden" for item in chain) else ""
            )

        if exists("report"):
            sources.append(
                CatalogSource(
                    key="report",
                    name=label("report"),
                    kind="report",
                    rows=[
                        {"id": row.id, "name": row.name}
                        for row in db.scalars(
                            select(ReportRow)
                            .where(ReportRow.dormitory_id == dorm.id)
                            .order_by(ReportRow.position, ReportRow.id)
                        )
                    ],
                )
            )
        if exists("places"):
            sources.append(
                CatalogSource(
                    key="places",
                    name=label("places"),
                    kind="places",
                    hostels=[
                        {"id": hostel.id, "name": hostel.name}
                        for hostel in db.scalars(
                            select(Hostel).where(Hostel.dormitory_id == dorm.id).order_by(Hostel.id)
                        )
                    ],
                )
            )
        for key in DEFAULT_COLUMNS:
            if exists(key):
                columns = ensure_columns(db, dorm.id, key)
                sources.append(
                    CatalogSource(
                        key=key,
                        name=label(key),
                        kind="table",
                        columns=[
                            ColumnResponse.model_validate(col)
                            for col in columns
                            if not col.archived and col.kind not in ("action", "hostel")
                        ],
                    )
                )
        tabs = list(
            db.scalars(
                select(CustomTab).where(CustomTab.dormitory_id == dorm.id).order_by(CustomTab.id)
            )
        )
        by_id = {tab.id: tab for tab in tabs}
        for tab in tabs:
            if not tab.table_created or tab.is_group:
                continue
            chain = [tab]
            while chain[0].parent_id in by_id:
                chain.insert(0, by_id[chain[0].parent_id])
            parent = chain[0].parent_section
            name = (label(parent) + " / " if parent else "") + " / ".join(
                item.name for item in chain
            )
            if any(not item.is_active for item in chain):
                name += " (скрыта)"
            sources.append(
                CatalogSource(
                    key=tab.table_key,
                    name=name,
                    kind="table",
                    columns=[
                        ColumnResponse.model_validate(col)
                        for col in ensure_columns(db, dorm.id, tab.table_key)
                        if not col.archived and col.kind not in ("action", "hostel")
                    ],
                )
            )
        result.append(
            CatalogDormitory(
                id=dorm.id, name=dorm.name, is_archived=dorm.is_archived, sources=sources
            )
        )
    return result


def table_values(
    db: Session, config: WidgetConfig, source: TableWidgetSource, start: date, end: date
) -> dict[str, Decimal]:
    daily, errors = table_daily_groups(db, config, source, start, end)
    if errors:
        raise HTTPException(422, next(iter(errors.values())))
    values: dict[str, Decimal] = {}
    for groups in daily.values():
        for label, number in groups.items():
            values[label] = values.get(label, Decimal(0)) + number
    return values


def table_daily_groups(
    db: Session, config: WidgetConfig, source: TableWidgetSource, start: date, end: date
) -> tuple[dict[date, dict[str, Decimal]], dict[date, str]]:
    """Read/filter table records once, keeping invalid numbers local to their date."""
    value_col = (
        checked_column(db, source, source.value_column_id, "number")
        if config.operation == "sum"
        else None
    )
    date_col = (
        checked_column(db, source, source.date_column_id, "date") if source.date_column_id else None
    )
    group_col = (
        checked_column(db, source, source.group_column_id) if config.grouping == "value" else None
    )
    filter_col = checked_column(db, source, source.filter.column_id) if source.filter else None
    daily: dict[date, dict[str, Decimal]] = {}
    errors: dict[date, str] = {}
    for row in records_for(db, source.dormitory_id, source.table_key):
        if filter_col and source.filter:
            value = record_value(row, filter_col)
            if source.filter.operator == "equals" and value != source.filter.value:
                continue
            if source.filter.operator == "not_empty" and (value is None or value == ""):
                continue
        if date_col:
            raw_date = record_value(row, date_col)
            if not raw_date:
                continue
            day = date.fromisoformat(raw_date)
        else:
            created = row.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=UTC)
            day = created.astimezone(ZoneInfo("Europe/Moscow")).date()
        if day > end or (config.period == "range" and day < start):
            continue
        label = ""
        if group_col:
            value = record_value(row, group_col)
            if group_col.kind == "select":
                value = next(
                    (item["label"] for item in group_col.options if item["id"] == value), value
                )
            if group_col.kind == "checkbox":
                value = "Да" if value else "Нет"
            label = str(value) if value is not None and value != "" else "Не указано"
        number = Decimal(1)
        if value_col:
            raw_number = record_value(row, value_col)
            if raw_number is None:
                errors[day] = f"Есть строки без значения «{value_col.name}»"
                continue
            try:
                number = Decimal(str(raw_number))
                if not number.is_finite():
                    raise InvalidOperation
            except InvalidOperation:
                errors[day] = f"Некорректное число в «{value_col.name}»"
                continue
        values = daily.setdefault(day, {})
        values[label] = values.get(label, Decimal(0)) + number
    return daily, errors


def place_value(db: Session, source: PlaceWidgetSource, days: list[date]) -> Decimal:
    values, errors = place_daily_values(db, source, days)
    if errors:
        day, message = next(iter(errors.items()))
        raise HTTPException(422, f"{message} за {day.strftime('%d.%m.%Y')}")
    return sum(values.values(), Decimal(0))


def place_daily_values(
    db: Session, source: PlaceWidgetSource, days: list[date]
) -> tuple[dict[date, Decimal], dict[date, str]]:
    hostels = list(db.scalars(select(Hostel).where(Hostel.dormitory_id == source.dormitory_id)))
    if source.hostel_id is not None:
        hostels = [hostel for hostel in hostels if hostel.id == source.hostel_id]
    cells = db.scalars(
        select(HostelCell).where(
            HostelCell.hostel_id.in_([item.id for item in hostels]),
            HostelCell.report_date >= days[0],
            HostelCell.report_date <= days[-1],
        )
    )
    raw: dict[tuple[int, date], dict[str, int]] = {}
    for cell in cells:
        raw.setdefault((cell.hostel_id, cell.report_date), {})[cell.field] = cell.value
    daily: dict[date, Decimal] = {}
    errors: dict[date, str] = {}
    for day in days:
        daily[day] = Decimal(0)
        for hostel in hostels:
            if not active_in_month(hostel, day.replace(day=1)):
                continue
            values = place_day_values(raw.get((hostel.id, day), {}))
            if source.metric not in values:
                errors[day] = "Нет показателя «Размещение персонала»"
            else:
                daily[day] += values[source.metric]
    return daily, errors


def widget_sources(config: WidgetConfig, dormitories: list[Dormitory]) -> dict[int, WidgetSource]:
    sources = {source.dormitory_id: source for source in config.sources}
    if config.source_kind == "arrival_plan" and config.all_dormitories:
        for dorm in dormitories:
            sources.setdefault(
                dorm.id, ArrivalPlanWidgetSource(kind="arrival_plan", dormitory_id=dorm.id)
            )
    return sources


def calculate_chart(
    db: Session,
    user: User,
    block: WidgetDefinition,
    included: list[Dormitory],
    start: date,
    end: date,
    reports: dict[int, ReportResponse],
) -> WidgetResult:
    """Aggregate one complete value per day, without repeating source queries per day."""
    config = block.config
    days = [start + timedelta(days=index) for index in range((end - start).days + 1)]
    totals: dict[date, Decimal | None] = {day: Decimal(0) for day in days}
    errors: list[str] = []
    sources = widget_sources(config, included)
    series: list[WidgetSeries] = []
    for dorm in sorted(included, key=lambda item: item.id):
        values: dict[date, Decimal] = {}
        invalid: dict[date, str] = {}
        try:
            source = sources.get(dorm.id)
            if source is None:
                raise HTTPException(422, "Не выбран источник. Откройте настройки блока.")
            validate_source(db, config, source)
            if isinstance(source, ReportWidgetSource):
                report = reports.get(dorm.id) or read_report(dorm.id, user, db, start, end, dorm)
                reports[dorm.id] = report
                row = next(item for item in report.rows if item.id == source.row_id)
                for day in days:
                    cell = row.values.get(day.isoformat())
                    if cell is None or day.isoformat() in row.errors:
                        invalid[day] = f"Строка «{row.name}» не заполнена или содержит ошибку"
                    else:
                        values[day] = Decimal(cell)
            elif isinstance(source, PlaceWidgetSource):
                values, invalid = place_daily_values(db, source, days)
            elif isinstance(source, ArrivalPlanWidgetSource):
                values = {
                    day: Decimal(count)
                    for day, count in report_arrivals(db, dorm.id, start, end).items()
                }
            else:
                groups, invalid = table_daily_groups(db, config, source, start, end)
                values = {day: sum(items.values(), Decimal(0)) for day, items in groups.items()}
                if config.period == "snapshot":
                    running = sum(
                        (value for day, value in values.items() if day < start), Decimal(0)
                    )
                    running_error = next(
                        (message for day, message in sorted(invalid.items()) if day < start), None
                    )
                    for day in days:
                        running += values.get(day, Decimal(0))
                        running_error = running_error or invalid.get(day)
                        values[day] = running
                        if running_error:
                            invalid[day] = running_error
        except (HTTPException, InvalidOperation, ValueError) as exc:
            message = (
                str(exc.detail)
                if isinstance(exc, HTTPException)
                else "Некорректное значение источника"
            )
            invalid = dict.fromkeys(days, message)
        if config.chart_mode == "dormitories":
            series.append(
                WidgetSeries(
                    dormitory_id=dorm.id,
                    label=dorm.name,
                    is_archived=dorm.is_archived,
                    daily=[
                        WidgetPoint(
                            date=day,
                            value=None if day in invalid else float(values.get(day, Decimal(0))),
                        )
                        for day in days
                    ],
                )
            )
        messages: dict[str, list[date]] = {}
        for day in days:
            if day in invalid:
                totals[day] = None
                messages.setdefault(invalid[day], []).append(day)
            else:
                current = totals[day]
                if current is not None:
                    totals[day] = current + values.get(day, Decimal(0))
        for message, dates in messages.items():
            labels = ", ".join(day.strftime("%d.%m.%Y") for day in dates[:5])
            if len(dates) > 5:
                labels += f" и ещё {len(dates) - 5} дат"
            errors.append(f"{dorm.name}: {message} ({labels})")
    if not included:
        totals = dict.fromkeys(days)
        errors.append("Нет выбранных общежитий")
    daily = [
        WidgetPoint(date=day, value=float(value) if value is not None else None)
        for day, value in totals.items()
    ]
    return WidgetResult(
        id=block.id, value=daily[-1].value, items=[], errors=errors, daily=daily, series=series
    )


def calculate_widget(
    db: Session,
    user: User,
    block: WidgetDefinition,
    dormitories: list[Dormitory],
    start: date,
    end: date | None,
    reports: dict[int, ReportResponse],
) -> WidgetResult:
    config = block.config
    sources = widget_sources(config, dormitories)
    included = [
        dorm
        for dorm in dormitories
        if dorm.id not in config.excluded_dormitory_ids
        and (config.all_dormitories or dorm.id in sources)
    ]
    items: list[WidgetValue] = []
    errors: list[str] = []
    groups: dict[str, Decimal] = {}
    total = Decimal(0)
    if end is None:
        return WidgetResult(
            id=block.id, value=None, items=[], errors=["За будущий период данных ещё нет"]
        )
    if config.display == "chart":
        return calculate_chart(db, user, block, included, start, end, reports)
    days = (
        [end]
        if config.period == "snapshot"
        else [start + timedelta(days=index) for index in range((end - start).days + 1)]
    )
    for dorm in included:
        source = sources.get(dorm.id)
        value: Decimal | None = None
        try:
            if source is None:
                raise HTTPException(422, "Не выбран источник. Откройте настройки блока.")
            validate_source(db, config, source)
            if isinstance(source, ReportWidgetSource):
                report = reports.get(dorm.id) or read_report(dorm.id, user, db, start, end, dorm)
                row = next(item for item in report.rows if item.id == source.row_id)
                cells = [row.values.get(day.isoformat()) for day in days]
                if any(
                    cell is None or day.isoformat() in row.errors
                    for day, cell in zip(days, cells, strict=True)
                ):
                    raise HTTPException(
                        422, f"Не все значения строки «{row.name}» заполнены или в ней ошибка"
                    )
                value = sum((Decimal(cell) for cell in cells if cell is not None), Decimal(0))
            elif isinstance(source, PlaceWidgetSource):
                value = place_value(db, source, days)
            elif isinstance(source, ArrivalPlanWidgetSource):
                value = Decimal(sum(report_arrivals(db, dorm.id, days[0], days[-1]).values()))
            else:
                values = table_values(db, config, source, start, end)
                value = sum(values.values(), Decimal(0))
                if config.grouping == "value":
                    for label, number in values.items():
                        groups[label] = groups.get(label, Decimal(0)) + number
        except (HTTPException, InvalidOperation, ValueError) as exc:
            message = (
                str(exc.detail)
                if isinstance(exc, HTTPException)
                else "Некорректное значение источника"
            )
            errors.append(f"{dorm.name}: {message}")
        if value is not None:
            total += value
        items.append(
            WidgetValue(
                label=dorm.name,
                value=float(value) if value is not None else None,
                is_archived=dorm.is_archived,
            )
        )
    if not included:
        errors.append("Нет выбранных общежитий")
    if config.grouping == "value":
        items = [
            WidgetValue(label=label, value=None if errors else float(value))
            for label, value in sorted(groups.items())
        ]
    return WidgetResult(
        id=block.id, value=None if errors else float(total), items=items, errors=errors
    )
