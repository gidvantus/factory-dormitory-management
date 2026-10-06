"""Поля списков выплат."""

from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

PaymentKind = Literal["advance", "settlement"]


class UpdatePaymentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    personnel_number: str | None = Field(default=None, max_length=40)
    full_name: str | None = Field(default=None, max_length=255)
    advance_amount: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    settlement_date: date | None = None

    @field_validator("personnel_number", "full_name")
    @classmethod
    def trim_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class PaymentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    personnel_number: str | None
    full_name: str | None
    advance_amount: Decimal | None
    settlement_date: date | None
