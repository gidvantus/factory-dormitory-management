"""Создание и чтение общежитий."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CreateDormitoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    client_name: str = Field(min_length=1, max_length=255)

    @field_validator("name", "client_name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("Название содержит недопустимый символ")
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Название не может быть пустым")
        return normalized


class DormitoryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    client_name: str
    created_at: datetime
