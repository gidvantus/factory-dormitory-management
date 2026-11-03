"""Серверные действия над одной строкой человека в плане заездов."""

from datetime import date
from typing import Literal

from pydantic import Field, model_validator

from app.schemas.personnel import IdentityChoice, StrictModel
from app.schemas.resident import UpdateResidentRequest


class VisitVersion(StrictModel):
    revision: int = Field(ge=0, strict=True)


class VisitMark(VisitVersion):
    status: Literal["expected", "arrived", "no_show"]


class VisitMove(VisitVersion):
    date: date


class VisitSettle(VisitVersion):
    identity: IdentityChoice
    hostel_id: int = Field(ge=1)
    settlement_date: date
    shift_start: date
    shift_end: date | None = None
    shift_count: int | None = Field(default=None, ge=0, le=1_000_000, strict=True)

    @model_validator(mode="after")
    def valid_dates_and_phone(self) -> "VisitSettle":
        if self.shift_end and self.shift_end < self.shift_start:
            raise ValueError("Конец вахты раньше начала")
        UpdateResidentRequest(phone=self.identity.phone)
        return self
