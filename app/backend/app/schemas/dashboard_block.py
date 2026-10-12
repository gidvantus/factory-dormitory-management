"""Настройки источников статистики с постоянными идентификаторами."""

from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.table_column import ColumnResponse, PlaceMetric, TableKey


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WidgetFilter(StrictModel):
    column_id: int = Field(ge=1)
    operator: Literal["equals", "not_empty"] = "equals"
    value: str | bool | int | float | None = None


class ReportWidgetSource(StrictModel):
    kind: Literal["report"]
    dormitory_id: int = Field(ge=1)
    row_id: int = Field(ge=1)


class PlaceWidgetSource(StrictModel):
    kind: Literal["places"]
    dormitory_id: int = Field(ge=1)
    metric: PlaceMetric
    hostel_id: int | None = Field(default=None, ge=1)


class TableWidgetSource(StrictModel):
    kind: Literal["table"]
    dormitory_id: int = Field(ge=1)
    table_key: TableKey
    value_column_id: int | None = Field(default=None, ge=1)
    date_column_id: int | None = Field(default=None, ge=1)
    group_column_id: int | None = Field(default=None, ge=1)
    filter: WidgetFilter | None = None


WidgetSource = Annotated[
    ReportWidgetSource | PlaceWidgetSource | TableWidgetSource, Field(discriminator="kind")
]


class WidgetConfig(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    display: Literal["number", "list", "chart"] = "number"
    chart_mode: Literal["total", "dormitories"] = "total"
    source_kind: Literal["report", "places", "table"]
    operation: Literal["count", "sum"] = "sum"
    period: Literal["snapshot", "range"] = "snapshot"
    grouping: Literal["dormitory", "value"] = "dormitory"
    all_dormitories: bool = True
    excluded_dormitory_ids: list[int] = Field(default_factory=list, max_length=1000)
    sources: list[WidgetSource] = Field(min_length=1, max_length=1000)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value or "\x00" in value:
            raise ValueError("Укажите название блока")
        return value

    @model_validator(mode="after")
    def consistent_sources(self) -> "WidgetConfig":
        ids = [source.dormitory_id for source in self.sources]
        if len(ids) != len(set(ids)) or set(ids) & set(self.excluded_dormitory_ids):
            raise ValueError("Укажите один источник для каждого выбранного общежития")
        if any(source.kind != self.source_kind for source in self.sources):
            raise ValueError("Выберите один тип источника для блока")
        if self.display == "chart" and self.grouping != "dormitory":
            raise ValueError("График поддерживает общий показатель или линии по общежитиям")
        if self.source_kind != "table" and (
            self.operation != "sum" or self.grouping != "dormitory"
        ):
            raise ValueError("Группировка по значению и подсчёт строк доступны для таблиц")
        return self


class WidgetMutation(StrictModel):
    revision: int = Field(ge=0)
    config: WidgetConfig


class LayoutMutation(StrictModel):
    revision: int = Field(ge=0)
    order: list[str] = Field(max_length=1004)
    hidden: list[str] = Field(default_factory=list, max_length=1004)


class WidgetDefinition(BaseModel):
    id: int
    config: WidgetConfig


class LayoutResponse(BaseModel):
    revision: int
    order: list[str]
    hidden: list[str]
    blocks: list[WidgetDefinition]


class WidgetValue(BaseModel):
    label: str
    value: float | None
    is_archived: bool = False


class WidgetPoint(BaseModel):
    date: date
    value: float | None


class WidgetSeries(BaseModel):
    dormitory_id: int
    label: str
    is_archived: bool = False
    daily: list[WidgetPoint]


class WidgetResult(BaseModel):
    id: int
    value: float | None
    items: list[WidgetValue]
    errors: list[str]
    daily: list[WidgetPoint] = Field(default_factory=list)
    series: list[WidgetSeries] = Field(default_factory=list)


class CatalogSource(BaseModel):
    key: str
    name: str
    kind: Literal["report", "places", "table"]
    columns: list[ColumnResponse] = Field(default_factory=list)
    rows: list[dict[str, int | str]] = Field(default_factory=list)
    hostels: list[dict[str, int | str]] = Field(default_factory=list)


class CatalogDormitory(BaseModel):
    id: int
    name: str
    is_archived: bool
    sources: list[CatalogSource]
