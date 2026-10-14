"""Сохранённые причины для текстовых столбцов оттока."""

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class OutflowReason(Base):
    __tablename__ = "outflow_reasons"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(ForeignKey("dormitories.id", ondelete="CASCADE"))
    column_id: Mapped[int] = mapped_column(ForeignKey("table_columns.id", ondelete="CASCADE"))
    normalized: Mapped[str] = mapped_column(String(255))
    label: Mapped[str] = mapped_column(String(255))
    __table_args__ = (UniqueConstraint("column_id", "normalized", name="uq_outflow_reason"),)
