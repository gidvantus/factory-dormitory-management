"""Проверяемые настройки универсальных блоков и результаты на выбранный период."""

from datetime import date, datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from app.schemas.dashboard_block import StrictModel, WidgetConfig, WidgetPoint, WidgetSeries


class StatisticsBlock(StrictModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    name: str = Field(min_length=1, max_length=120)
    display: Literal["number", "line", "bar", "area", "pie", "table"] = "line"
    aggregation: Literal["sum", "average", "last", "max"] = "sum"
    breakdown: Literal["date", "dormitory"] = "date"
    selected_dormitory_ids: list[int] = Field(default_factory=list, max_length=1000)
    query: WidgetConfig

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return WidgetConfig.clean_name(value)

    @model_validator(mode="after")
    def valid_query(self) -> "StatisticsBlock":
        if self.query.grouping != "dormitory":
            raise ValueError("Выберите группировку по общежитиям")
        if not self.query.all_dormitories and not self.selected_dormitory_ids:
            raise ValueError("Выберите хотя бы одно общежитие")
        if any(item < 1 for item in self.selected_dormitory_ids):
            raise ValueError("Некорректное общежитие")
        if len(set(self.selected_dormitory_ids)) != len(self.selected_dormitory_ids):
            raise ValueError("Общежития не должны повторяться")
        return self


class CreateStatisticsReport(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    visibility: Literal["shared", "personal"] = "shared"
    blocks: list[StatisticsBlock] = Field(default_factory=list, max_length=40)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return WidgetConfig.clean_name(value)

    @model_validator(mode="after")
    def unique_blocks(self) -> "CreateStatisticsReport":
        if len({block.id for block in self.blocks}) != len(self.blocks):
            raise ValueError("Блоки не должны повторяться")
        return self


class UpdateStatisticsReport(CreateStatisticsReport):
    revision: int = Field(ge=0)


class StatisticsReportResponse(CreateStatisticsReport):
    id: int
    revision: int
    created_by_id: int | None
    created_by_name: str
    can_manage: bool
    created_at: datetime
    updated_at: datetime


class StatisticsItem(StrictModel):
    dormitory_id: int
    label: str
    is_archived: bool
    value: float | None


class StatisticsResult(StrictModel):
    id: str
    value: float | None
    daily: list[WidgetPoint] = Field(default_factory=list)
    series: list[WidgetSeries] = Field(default_factory=list)
    items: list[StatisticsItem] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class StatisticsData(StrictModel):
    revision: int
    from_date: date
    to_date: date
    through_date: date | None
    results: list[StatisticsResult]
