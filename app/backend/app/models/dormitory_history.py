"""История данных общежития, независимая от пользовательских вкладок."""

from datetime import UTC, datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class DormitoryDataEvent(Base):
    __tablename__ = "dormitory_data_events"
    __table_args__ = (Index("ix_dormitory_history_page", "dormitory_id", "created_at", "id"),)

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), nullable=False
    )
    organization_id: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), server_default=func.now()
    )
    actor_id: Mapped[int] = mapped_column(Integer, nullable=False)
    actor_name: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
