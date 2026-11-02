"""Серверные действия над одной строкой человека в плане заездов."""

from datetime import date
from typing import Literal

from pydantic import Field

from app.schemas.personnel import StrictModel


class VisitVersion(StrictModel):
    revision: int = Field(ge=0, strict=True)


class VisitMark(VisitVersion):
    status: Literal["expected", "arrived", "no_show"]


class VisitMove(VisitVersion):
    date: date
