"""Предварительное сравнение и подтверждение перевода проживающего."""

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TransferPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_dormitory_id: int = Field(ge=1, le=2147483647)
    month: date

    @field_validator("month")
    @classmethod
    def first_day(cls, value: date) -> date:
        if value.day != 1:
            raise ValueError("Укажите первый день месяца")
        return value


class TransferResidentRequest(TransferPreviewRequest):
    preview_token: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirm_loss: bool = Field(default=False, strict=True)


class TransferWarning(BaseModel):
    column: str
    reason: str


class TransferPreviewResponse(BaseModel):
    target_dormitory_id: int
    matched_columns: list[str]
    warnings: list[TransferWarning]
    empty_columns: list[str]
    preview_token: str
