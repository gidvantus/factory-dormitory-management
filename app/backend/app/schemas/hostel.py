"""Запросы и ответы вкладки «Размещение персонала»."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.table_column import ArrivalPlanReportLink, ReportLink

PlaceField = Literal["residents_m", "residents_f", "paid_m", "paid_f"]
RowKey = str


class ResidentsOccupancyLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    table_key: Literal["resident_occupancy"]
    gender: Literal["М", "Ж", "all"]


class HostelTableLink(ReportLink):
    count_mode: Literal["daily", "snapshot"] = "daily"
    scope: Literal["dormitory", "hostel"] = "dormitory"

    @model_validator(mode="after")
    def check_count_mode(self) -> "HostelTableLink":
        if self.scope == "hostel" and self.table_key != "residents":
            raise ValueError("Подсчёт по хостелу доступен для таблицы «Проживающие»")
        if self.count_mode == "snapshot" and (
            self.scope != "hostel" or self.date_column_id is not None
        ):
            raise ValueError("Для состава на дату выберите текущий хостел")
        return self


class HostelReportLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    table_key: Literal["report"]
    row_id: int = Field(ge=1)


class HostelRow(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    key: RowKey = Field(pattern=r"^(?:[a-z_]{1,24}|r_[0-9a-f]{20})$")
    name: str = Field(min_length=1, max_length=120, pattern=r"^[^\[\]\x00\r\n]+$")
    formula: str | None = Field(default=None, min_length=1, max_length=1000)
    display_percent: bool = False
    link: (
        ResidentsOccupancyLink | HostelReportLink | HostelTableLink | ArrivalPlanReportLink | None
    ) = None
    archived: bool = False

    @model_validator(mode="after")
    def exclusive_source(self) -> "HostelRow":
        if self.formula is not None and self.link is not None:
            raise ValueError("Выберите формулу или связь с таблицей")
        return self


def normalize_month(value: date) -> date:
    if value.day != 1:
        raise ValueError("Укажите первый день месяца")
    return value


class CreateHostelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    month: date
    rows: list[HostelRow] | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        name = " ".join(value.split())
        if not name or "\x00" in name:
            raise ValueError("Укажите название хостела")
        return name

    @field_validator("month")
    @classmethod
    def validate_month(cls, value: date) -> date:
        return normalize_month(value)


class UpdateHostelRequest(CreateHostelRequest):
    rows: list[HostelRow] = Field(min_length=1, max_length=100)
    version: int = Field(ge=0)


class HostelTemplateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=120, pattern=r"^[^\x00\r\n]+$")
    rows: list[HostelRow] = Field(min_length=1, max_length=100)


class SaveHostelCellRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: int | None = Field(ge=0, le=1_000_000_000)


class HostelResponse(BaseModel):
    id: int
    name: str
    rows: list[HostelRow]
    version: int
    values: dict[str, dict[str, int | str]]
    errors: dict[str, dict[str, str]] = Field(default_factory=dict)


class HostelMonthResponse(BaseModel):
    month: date
    days: list[date]
    hostels: list[HostelResponse]


class PlacesResponse(BaseModel):
    months: list[HostelMonthResponse]
