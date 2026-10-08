"""Поля таблицы оттока персонала."""

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, field_validator


class UpdateOutflowRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    departure_date: date | None = None
    personnel_number: str | None = Field(default=None, max_length=40)
    full_name: str | None = Field(default=None, max_length=255)
    shift_start: date | None = None
    reason: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=5000)
    additional_info: str | None = Field(default=None, max_length=5000)

    @field_validator("personnel_number", "full_name", "reason", "notes", "additional_info")
    @classmethod
    def trim_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class OutflowResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    custom_values: dict[str, str | bool | int | float | None] = Field(default_factory=dict)

    id: int
    departure_date: date | None
    personnel_number: str | None
    full_name: str | None
    shift_start: date | None
    reason: str | None
    notes: str | None
    additional_info: str | None
