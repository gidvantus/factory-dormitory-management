"""Поля и ответы таблицы проживающих."""

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class UpdateResidentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gender: Literal["М", "Ж"] | None = None
    personnel_number: str | None = Field(default=None, max_length=40)
    full_name: str | None = Field(default=None, max_length=255)
    hostel_id: int | None = Field(default=None, ge=1)
    shift_start: date | None = None
    shift_count: int | None = Field(default=None, ge=0, le=1_000_000)
    shift_end: date | None = None
    phone: str | None = Field(default=None, max_length=30)
    medical_book: Literal["Есть", "Нет", "Делается"] | None = None
    notes: str | None = Field(default=None, max_length=5000)

    @field_validator("personnel_number", "full_name", "notes", "phone")
    @classmethod
    def trim_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str | None) -> str | None:
        if value and (
            not re.fullmatch(r"\+?[0-9 ()-]+", value)
            or not 10 <= len(re.sub(r"\D", "", value)) <= 15
        ):
            raise ValueError("Укажите номер телефона из 10–15 цифр")
        return value


class ResidentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    custom_values: dict[str, str | bool | int | float | None] = Field(default_factory=dict)

    id: int
    gender: str | None
    personnel_number: str | None
    full_name: str | None
    hostel_id: int | None
    hostel_name: str | None
    shift_start: date | None
    shift_count: int | None
    shift_end: date | None
    phone: str | None
    medical_book: str | None
    notes: str | None


class HostelOption(BaseModel):
    id: int
    name: str


class ResidentsResponse(BaseModel):
    residents: list[ResidentResponse]
    hostels: list[HostelOption]
