"""Очередь импорта таблиц с результатом для безопасного повтора запроса."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, LargeBinary, String, false, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

ImportStatus = Literal["pending", "completed", "failed", "cancelled"]


class TableImportJob(Base):
    __tablename__ = "table_import_jobs"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(ForeignKey("dormitories.id", ondelete="CASCADE"))
    table_key: Mapped[str] = mapped_column(String(32))
    actor_id: Mapped[int] = mapped_column()
    organization_id: Mapped[int] = mapped_column()
    impersonated: Mapped[bool] = mapped_column(Boolean)
    from_date: Mapped[date | None] = mapped_column(Date)
    to_date: Mapped[date | None] = mapped_column(Date)
    checksum: Mapped[str] = mapped_column(String(64))
    content: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    status: Mapped[ImportStatus] = mapped_column(String(16), default="pending")
    detail: Mapped[str | None] = mapped_column()
    rows_added: Mapped[int] = mapped_column(default=0)
    cells_added: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    progress: Mapped[TableImportProgress | None] = relationship()

    @property
    def cancel_requested(self) -> bool:
        progress = self.progress
        return self.status == "pending" and progress is not None and progress.cancel_requested


class TableImportProgress(Base):
    __tablename__ = "table_import_progress"

    job_id: Mapped[UUID] = mapped_column(
        ForeignKey("table_import_jobs.id", ondelete="CASCADE"), primary_key=True
    )
    rows_processed: Mapped[int] = mapped_column()
    rows_total: Mapped[int] = mapped_column()
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
