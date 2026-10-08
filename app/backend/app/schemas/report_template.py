"""Создание и отображение снимков структуры отчёта."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CreateReportTemplateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    dormitory_id: int = Field(ge=1)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized or "\x00" in normalized:
            raise ValueError("Укажите название шаблона")
        return normalized


class ReportTemplateResponse(BaseModel):
    id: int
    name: str
    row_count: int
    created_at: datetime


class ReportTemplateRowResponse(BaseModel):
    linked: bool = False
    name: str
    position: int
    formula: str | None


class ReportTemplateDetailResponse(ReportTemplateResponse):
    rows: list[ReportTemplateRowResponse]
