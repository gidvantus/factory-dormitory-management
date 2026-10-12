"""Сравнение столбцов и подтверждение переноса в отток."""

from datetime import date

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.resident_transfer import TransferWarning


class ResidentOutflowRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preview_token: str = Field(pattern=r"^[0-9a-f]{64}$")
    confirm_loss: bool = Field(default=False, strict=True)


class ResidentOutflowPreview(BaseModel):
    matched_columns: list[str]
    warnings: list[TransferWarning]
    empty_columns: list[str]
    departure_date: date | None
    payments_to_delete: dict[str, int]
    preview_token: str
