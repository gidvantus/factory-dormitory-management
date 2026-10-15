"""Настройки отображения не изменяют сохранённые строки и дневные значения."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTab
from app.models.table_column import TableColumn
from app.schemas.custom_tab import TabOptions
from app.table_data import columns_for


def options_for(tab: CustomTab) -> TabOptions:
    return TabOptions.model_validate(tab.options or {})


def validate_options(db: Session, tab: CustomTab, options: TabOptions) -> None:
    if options.date_column_id is not None:
        column = db.get(TableColumn, options.date_column_id)
        if (
            not column
            or column.dormitory_id != tab.dormitory_id
            or column.table_key != tab.table_key
            or column.archived
            or column.kind != "date"
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
