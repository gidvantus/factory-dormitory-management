"""Проверяемые настройки столбцов и связей отчёта."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

TableKey = Literal["residents", "inflow", "outflow", "advance", "settlement", "archive"]
ColumnKind = Literal["text", "number", "date", "checkbox", "select", "action", "hostel"]


class ColumnOption(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str | None = Field(default=None, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    archived: bool = False

    @field_validator("label")
    @classmethod
    def label_not_blank(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value or "\x00" in value:
            raise ValueError("Укажите название варианта")
        return value


class ColumnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    kind: ColumnKind
    options: list[ColumnOption] = Field(default_factory=list, max_length=200)

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value or "\x00" in value:
            raise ValueError("Укажите название столбца")
        return value


class ColumnResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    table_key: TableKey
    builtin_key: str | None
    name: str
    kind: str
    position: int
    options: list[dict[str, Any]]
    archived: bool


class CellRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str | bool | int | float | None


class ReportLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    table_key: TableKey
    column_id: int = Field(ge=1)
    operator: Literal["equals", "not_empty"] = "equals"
    value: str | bool | int | float | None = None
    date_column_id: int | None = Field(default=None, ge=1)
