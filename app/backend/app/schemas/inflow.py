"""Поля таблицы притока персонала."""

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, field_validator


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

    id: int
    settlement_date: date | None
    personnel_number: str | None
    full_name: str | None
    citizenship: str | None
    notes: str | None
    shift_count: int | None
