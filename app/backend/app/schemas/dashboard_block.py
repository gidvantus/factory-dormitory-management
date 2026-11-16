"""Настройки источников статистики с постоянными идентификаторами."""

from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.report_defaults import ReportMetric
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


class ArrivalPlanWidgetSource(StrictModel):
    kind: Literal["arrival_plan"]
    dormitory_id: int = Field(ge=1)


class TableWidgetSource(StrictModel):
    kind: Literal["table"]
    dormitory_id: int = Field(ge=1)
    table_key: TableKey
    value_column_id: int | None = Field(default=None, ge=1)
    date_column_id: int | None = Field(default=None, ge=1)
    group_column_id: int | None = Field(default=None, ge=1)
    filter: WidgetFilter | None = None


WidgetSource = Annotated[
    ReportWidgetSource | PlaceWidgetSource | ArrivalPlanWidgetSource | TableWidgetSource,
    Field(discriminator="kind"),
]


class SummaryMetric(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    aggregate: Literal["sum", "average", "last"] = "sum"
    sources: list[ReportWidgetSource] = Field(default_factory=list, max_length=1000)


class SummaryConfig(StrictModel):
    view: Literal["totals", "daily"] = "totals"
    label: Literal["dormitory", "client"] = "dormitory"
    dormitory_ids: list[int] = Field(default_factory=list, max_length=1000)
    metrics: list[SummaryMetric] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_metrics(self) -> "SummaryConfig":
        names = [" ".join(metric.name.lower().replace("ё", "е").split()) for metric in self.metrics]
        if any(not name for name in names) or len(names) != len(set(names)):
            raise ValueError("Выберите разные показатели с непустыми названиями")
        for metric in self.metrics:
            ids = [source.dormitory_id for source in metric.sources]
            if len(ids) != len(set(ids)):
                raise ValueError("Выберите одну строку показателя на общежитие")
        return self


class WidgetConfig(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    display: Literal["number", "list", "chart", "summary"] = "number"
    chart_mode: Literal["total", "dormitories"] = "total"
    source_kind: Literal["report", "places", "arrival_plan", "table"]
    operation: Literal["count", "sum"] = "sum"
    period: Literal["snapshot", "range"] = "snapshot"
    grouping: Literal["dormitory", "value"] = "dormitory"
    all_dormitories: bool = True
    excluded_dormitory_ids: list[int] = Field(default_factory=list, max_length=1000)
    sources: list[WidgetSource] = Field(default_factory=list, max_length=1000)
    summary: SummaryConfig | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value or "\x00" in value:
            raise ValueError("Укажите название блока")
        return value

    @model_validator(mode="after")
    def consistent_sources(self) -> "WidgetConfig":
        if self.display == "summary":
            if self.summary is None or self.source_kind != "report" or self.period != "range":
                raise ValueError("Для сводного отчёта выберите строки общего отчёта и период")
            if not self.all_dormitories and not self.summary.dormitory_ids:
                raise ValueError("Выберите хотя бы одно общежитие")
        elif not self.sources:
            raise ValueError("Выберите хотя бы один источник")
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


class BuiltinBlockConfig(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    date_mode: Literal["overview", "date", "range"] = "overview"
    aggregate: Literal["last", "average", "sum"] = "last"

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return WidgetConfig.clean_name(value)


class LayoutMutation(StrictModel):
    revision: int = Field(ge=0)
    order: list[str] = Field(max_length=1004)
    hidden: list[str] = Field(default_factory=list, max_length=1004)
    builtin_settings: dict[ReportMetric, BuiltinBlockConfig] | None = None


class WidgetDefinition(BaseModel):
    id: int
    config: WidgetConfig


class LayoutResponse(BaseModel):
    revision: int
    order: list[str]
    hidden: list[str]
    blocks: list[WidgetDefinition]
    builtin_settings: dict[ReportMetric, BuiltinBlockConfig] = Field(default_factory=dict)


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
    summary: "SummaryResult | None" = None


class SummaryValue(BaseModel):
    dormitory_id: int
    label: str
    metric: str
    row_name: str | None = None
    aggregate: Literal["sum", "average", "last"]
    value: float | None
    daily: list[WidgetPoint]


class SummaryResult(BaseModel):
    dates: list[date]
    rows: list[SummaryValue]


class CatalogSource(BaseModel):
    key: str
    name: str
    kind: Literal["report", "places", "arrival_plan", "table"]
    columns: list[ColumnResponse] = Field(default_factory=list)
    rows: list[dict[str, int | str]] = Field(default_factory=list)
    hostels: list[dict[str, int | str]] = Field(default_factory=list)


class CatalogDormitory(BaseModel):
    id: int
    name: str
    client_name: str | None = None
    is_archived: bool
    sources: list[CatalogSource]
