"""Создание вкладок и копирование только структуры таблицы."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.table_column import ColumnRequest


class TabOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    table_format: Literal["list", "calendar"] = "list"
    period_mode: Literal["none", "range", "month"] = "none"
    date_column_id: int | None = Field(default=None, ge=1)
    add_row: bool = True
    clear_list: bool = False
    row_actions: bool = True
    show_dates: bool = True

    @model_validator(mode="after")
    def calendar_period(self) -> "TabOptions":
        if self.table_format == "calendar" and self.period_mode == "none":
            raise ValueError("Для дат в столбцах выберите месяц или диапазон дат")
        return self


class CreateTabRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    source_tab_id: int | None = Field(default=None, ge=1, le=2147483647)
    parent_id: int | None = Field(default=None, ge=1, le=2147483647)
    parent_section: str | None = None
    subtabs: list[str] = Field(default_factory=list)
    options: TabOptions | None = None

    @field_validator("subtabs")
    @classmethod
    def valid_subtabs(cls, values: list[str]) -> list[str]:
        names = [cls.name_not_blank(value) for value in values]
        if any(len(name) > 120 for name in names) or len(
            {name.casefold().replace("ё", "е") for name in names}
        ) != len(names):
            raise ValueError(
                "Названия подвкладок должны быть уникальными и не длиннее 120 символов"
            )
        return names

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value or "\x00" in value:
            raise ValueError("Укажите название вкладки")
        return value


class TabResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    dormitory_id: int
    name: str
    parent_id: int | None = None
    parent_section: str | None = None
    is_group: bool = False
    table_key: str
    table_created: bool
    is_active: bool
    options: TabOptions = Field(default_factory=TabOptions)
    has_data: bool = False
    delete_block_reason: str | None = None


class UpdateTabRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_active: bool


class TabTemplateResponse(TabResponse):
    dormitory_name: str
    client_name: str


class CreateTabTableRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    columns: list[ColumnRequest] = Field(min_length=1)


class TabEntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    employee_id: str | None = None
    custom_values: dict[str, Any]
    calendar_values: dict[str, str] = Field(default_factory=dict)


class CalendarCellRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str = Field(max_length=2000)
