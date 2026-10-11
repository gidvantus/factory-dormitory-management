"""Создание и чтение общежитий."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.tab_catalog import TabChoice


class CreateDormitoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    client_name: str = Field(min_length=1, max_length=255)
    template_id: int | None = Field(default=None, ge=1)
    tabs: list[TabChoice] | None = None
    structure_template_id: int | None = Field(default=None, ge=1)
    structure_template_keys: list[str] | None = None

    @model_validator(mode="after")
    def one_structure(self) -> "CreateDormitoryRequest":
        if self.structure_template_id and (self.tabs is not None or self.template_id):
            raise ValueError("Выберите один способ создания структуры")
        if self.structure_template_keys is not None and not self.structure_template_id:
            raise ValueError("Выберите шаблон структуры")
        return self

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
    section_states: dict[str, str] = Field(default_factory=dict)
    section_parents: dict[str, str | None] = Field(default_factory=dict)
    created_at: datetime
