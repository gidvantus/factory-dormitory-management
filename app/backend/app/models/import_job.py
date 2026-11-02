"""Журнал импортов таблиц общежития: файл, разбор и применение.

Разбор файла и применение — два разных запроса, поэтому результат разбора
хранится в `result` (JSON) и «Применить» читает именно его: повторно файл не
разбирается. Запись нужна и для неудачного разбора: статус `failed` объясняет,
почему задание нельзя применить.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# Раздел, к которому относится задание. Пока импорт есть только в «Размещении персонала».
IMPORT_TABLE_PLACES = "places"
# Разбор прошёл и задание можно применять / разбор с ошибками / уже применено.
IMPORT_STATUS_READY = "ready"
IMPORT_STATUS_FAILED = "failed"
IMPORT_STATUS_APPLIED = "applied"


class ImportJob(Base):
    __tablename__ = "import_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dormitory_id: Mapped[int] = mapped_column(
        ForeignKey("dormitories.id", ondelete="CASCADE"), index=True
    )
    table_key: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    # Ключ исходного файла в хранилище (`app/storage.py`) — без префикса
    # `uploads/`, например `2026-10-29/<uuid>.xlsx`. Nullable: у заданий,
    # разобранных до появления хранилища, файла нет. По этой колонке
    # `app/file_access.can_read` находит общежитие и его организацию, поэтому
    # доступ к файлу решает принадлежность данных, а не факт загрузки.
    file_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Автор импорта: пользователя можно удалить, задание при этом остаётся.
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
