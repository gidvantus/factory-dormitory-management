"""Настройки отображения не изменяют сохранённые строки и дневные значения."""

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.dormitory_arrivals import source_fields
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.table_column import TableColumn
from app.schemas.custom_tab import TabOptions
from app.table_data import columns_for

ARCHIVE_OPTIONS = TabOptions(
    period_mode="range",
    add_row=False,
    clear_list=False,
    row_actions=False,
    show_dates=True,
    import_enabled=False,
)


def options_for(tab: CustomTab) -> TabOptions:
    if tab.kind == "archive":
        return ARCHIVE_OPTIONS.model_copy(
            update={"export_enabled": (tab.options or {}).get("export_enabled", True)}
        )
    return TabOptions.model_validate(tab.options or {})


def validate_options(db: Session, tab: CustomTab, options: TabOptions) -> None:
    if tab.kind == "archive":
        if "import_enabled" not in options.model_fields_set:
            options.import_enabled = False
        if options.model_copy(update={"export_enabled": True}) != ARCHIVE_OPTIONS:
            raise HTTPException(422, "У архива постоянные столбцы: Дата, Действие и Автор")
        return
    if options.data_source == "arrival_plan":
        if (
            db.scalar(select(CustomTabEntry.id).where(CustomTabEntry.tab_id == tab.id).limit(1))
            is not None
        ):
            raise HTTPException(
                409,
                "Для связи с планом заездов используйте пустую вкладку. "
                "Существующие записи сохраняются.",
            )
        dorm = db.get(Dormitory, tab.dormitory_id)
        assert dorm is not None
        sources = {field["id"] for field in source_fields(db, dorm.organization_id)}
        columns = columns_for(db, tab.dormitory_id, tab.table_key)
        mapping = {}
        for column in columns:
            if column.archived or column.kind == "action":
                continue
            field = options.arrival_columns.get(
                str(column.id), options.arrival_columns.get("name:" + column.name)
            )
            if field is not None:
                if field not in sources:
                    raise HTTPException(
                        422,
                        f"Поле плана заездов для столбца «{column.name}» недоступно. "
                        "Выберите другое поле.",
                    )
                if column.fill or column.kind == "formula":
                    raise HTTPException(
                        422, "Для полей плана заездов отключите формулы и другие связи столбца"
                    )
                mapping[str(column.id)] = field
        if not mapping and tab.table_created:
            raise HTTPException(422, "Выберите поля плана заездов для столбцов вкладки")
        options.arrival_columns = mapping
        return
    if options.date_column_id is not None:
        date_column = db.get(TableColumn, options.date_column_id)
        if (
            not date_column
            or date_column.dormitory_id != tab.dormitory_id
            or date_column.table_key != tab.table_key
            or date_column.archived
            or date_column.kind != "date"
        ):
            raise HTTPException(422, "Выберите действующий столбец типа «Дата» этой вкладки")
    if (
        tab.table_created
        and options.table_format == "list"
        and options.period_mode != "none"
        and options.date_column_id is None
    ):
        raise HTTPException(422, "Для фильтрации периода выберите столбец типа «Дата»")


def initialize_options(db: Session, tab: CustomTab, options: TabOptions) -> None:
    """Новая вкладка сразу получает основу для выбранного периода/календаря."""
    if tab.kind == "archive":
        tab.options = ARCHIVE_OPTIONS.model_copy(
            update={"export_enabled": options.export_enabled}
        ).model_dump()
        tab.table_created = True
        return
    if options.data_source == "arrival_plan":
        mapping = {}
        for position, (name, kind, field) in enumerate(
            [("ФИО", "text", "full_name"), ("Дата", "date", "date"), ("Статус", "text", "status")]
        ):
            column = TableColumn(
                dormitory_id=tab.dormitory_id,
                table_key=tab.table_key,
                name=name,
                kind=kind,
                position=position,
                options=[],
                archived=False,
            )
            db.add(column)
            db.flush()
            mapping[str(column.id)] = field
        options.arrival_columns = mapping
        tab.options = options.model_dump()
        tab.table_created = True
        return
    if options.date_column_id is not None:
        raise HTTPException(422, "В новой вкладке столбец даты создаётся автоматически")
    if options.table_format == "calendar" or options.period_mode != "none":
        definitions: list[tuple[str, str, str | None]] = [
            ("Показатель" if options.table_format == "calendar" else "Наименование", "text", None)
        ]
        if options.table_format == "list":
            definitions.append(("Дата", "date", None))
        definitions.append(("Удалить", "action", "action_delete"))
        for position, (name, kind, builtin) in enumerate(definitions):
            column = TableColumn(
                dormitory_id=tab.dormitory_id,
                table_key=tab.table_key,
                name=name,
                kind=kind,
                builtin_key=builtin,
                position=position,
                options=[],
                archived=False,
            )
            db.add(column)
            db.flush()
            if kind == "date":
                options = options.model_copy(update={"date_column_id": column.id})
        tab.table_created = True
    tab.options = options.model_dump()


def mapped_options(tab: CustomTab, mapping: dict[int, int]) -> dict:
    options = options_for(tab).model_dump()
    if options["date_column_id"] is not None:
        options["date_column_id"] = mapping.get(options["date_column_id"])
    options["arrival_columns"] = {
        str(mapping[int(key)]): field
        for key, field in options["arrival_columns"].items()
        if key.isdecimal() and int(key) in mapping
    }
    return options


def resolve_date_name(db: Session, tab: CustomTab, name: str) -> int:
    candidates = [
        col
        for col in columns_for(db, tab.dormitory_id, tab.table_key)
        if not col.archived and col.kind == "date" and col.name == name
    ]
    if len(candidates) != 1:
        raise HTTPException(422, "Не найден выбранный столбец даты. Сохраните столбцы и повторите.")
    return candidates[0].id
