"""Поля таблицы притока персонала."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.outflow import OutflowFields
from app.schemas.personnel import IdentityChoice
from app.schemas.resident import HostelOption
from app.schemas.resident_transfer import TransferWarning
from app.schemas.table_column import ColumnResponse


class UpdateInflowRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    settlement_date: date | None = None
    personnel_number: str | None = Field(default=None, max_length=40)
    full_name: str | None = Field(default=None, max_length=255)
    citizenship: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=5000)
    shift_count: int | None = Field(default=None, ge=0, le=1_000_000)

    @field_validator("personnel_number", "full_name", "citizenship", "notes")
    @classmethod
    def trim_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class InflowResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    custom_values: dict[str, str | bool | int | float | None] = Field(default_factory=dict)

    id: int
    employee_id: str | None = None
    settlement_date: date | None
    personnel_number: str | None
    full_name: str | None
    citizenship: str | None
    notes: str | None
    shift_count: int | None
    processed_as: Literal["residents", "outflow"] | None = None
    processed_row_id: int | None = None
    processed_at: datetime | None = None


class InflowActionPreview(BaseModel):
    destination: Literal["residents", "outflow"]
    preview_token: str
    matched_columns: list[str]
    warnings: list[TransferWarning]
    empty_columns: list[str]
    fields: OutflowFields | None
    departure_date: date | None


class InflowActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preview_token: str = Field(pattern=r"^[0-9a-f]{64}$")
    reason: str | None = Field(default=None, max_length=255)
    departure_date: date | None = None


class InflowActionResponse(BaseModel):
    inflow: InflowResponse
    destination: Literal["residents", "outflow"]
    row_id: int


class InflowEntryForm(BaseModel):
    columns: list[ColumnResponse]
    hostels: list[HostelOption]
    month: date
    schema_token: str


class InflowEntryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    identity: IdentityChoice
    month: date
    schema_token: str = Field(pattern=r"^[0-9a-f]{64}$")
    values: dict[str, str | bool | int | float | None] = Field(default_factory=dict, max_length=200)
