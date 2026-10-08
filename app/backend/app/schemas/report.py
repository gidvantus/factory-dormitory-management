"""Входные данные и ответы конструктора большого отчёта."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.table_column import ReportLink


def normalize_name(value: str) -> str:
    name = " ".join(value.split())
    if not name or any(char in name for char in "[]\x00"):
        raise ValueError("Название строки не может быть пустым и содержать [ или ]")
    if len(name) > 120:
        raise ValueError("Название строки не длиннее 120 символов")
    return name


class CreateReportRowRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    link: ReportLink | None = None

    name: str = Field(min_length=1, max_length=120)
    formula: str | None = Field(default=None, max_length=1000)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return normalize_name(value)

    @field_validator("formula")
    @classmethod
    def normalize_formula(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None


class UpdateReportRowRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    link: ReportLink | None = None

    name: str | None = Field(default=None, max_length=120)
    formula: str | None = Field(default=None, max_length=1000)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str | None) -> str | None:
        return normalize_name(value) if value is not None else None

    @field_validator("formula")
    @classmethod
    def normalize_formula(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None


class MoveReportRowRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    direction: Literal["up", "down"]


class SaveReportCellRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str | None = Field(default=None, max_length=200)

    @field_validator("value")
    @classmethod
    def normalize_value(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class ReportRowResponse(BaseModel):
    link: ReportLink | None = None
    id: int
    name: str
    position: int
    formula: str | None
    values: dict[str, str]
    errors: dict[str, str]


class ReportResponse(BaseModel):
    from_date: date
    to_date: date
    rows: list[ReportRowResponse]
