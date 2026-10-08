"""Создание и чтение общежитий."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CreateDormitoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    client_name: str = Field(min_length=1, max_length=255)
    template_id: int | None = Field(default=None, ge=1)

    @field_validator("name", "client_name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("Название содержит недопустимый символ")
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Название не может быть пустым")
        return normalized


class UpdateDormitoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    client_name: str | None = Field(default=None, min_length=1, max_length=255)
    is_archived: bool | None = Field(default=None, strict=True)

    @field_validator("name", "client_name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("Название не может быть пустым")
        return CreateDormitoryRequest.normalize_name(value)

    @field_validator("is_archived")
    @classmethod
    def validate_archived(cls, value: bool | None) -> bool:
        if value is None:
            raise ValueError("Укажите статус архива")
        return value


class DormitoryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    client_name: str
    is_archived: bool
    created_at: datetime
