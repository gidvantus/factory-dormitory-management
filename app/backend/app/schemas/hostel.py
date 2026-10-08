"""Запросы и ответы вкладки «Места»."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

PlaceField = Literal["residents_m", "residents_f", "paid_m", "paid_f"]


def normalize_month(value: date) -> date:
    if value.day != 1:
        raise ValueError("Укажите первый день месяца")
    return value


class CreateHostelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    month: date

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


class SaveHostelCellRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: int | None = Field(ge=0, le=1_000_000_000)


class HostelResponse(BaseModel):
    id: int
    name: str
    values: dict[str, dict[str, int]]


class HostelMonthResponse(BaseModel):
    month: date
    days: list[date]
    hostels: list[HostelResponse]


class PlacesResponse(BaseModel):
    months: list[HostelMonthResponse]
