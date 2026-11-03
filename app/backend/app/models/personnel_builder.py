"""Общие подвкладки персонала организации и версия для защиты совместных правок."""

from typing import Any

from sqlalchemy import JSON, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PersonnelBuilder(Base):
    __tablename__ = "personnel_builders"

    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True
    )
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
