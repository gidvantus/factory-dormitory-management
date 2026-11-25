"""Сопоставление исходных и целевых столбцов."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

TransferTable = Literal["residents", "inflow", "outflow", "advance", "settlement"]
ColumnId = Annotated[int, Field(ge=1, le=2147483647)]


class ColumnOption(BaseModel):
    id: int
    name: str


class TransferColumnChoice(BaseModel):
    source: ColumnOption
    targets: list[ColumnOption]
    target_id: int | None = None


class TransferColumnUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mappings: dict[ColumnId, ColumnId | None] = Field(min_length=1, max_length=200)
