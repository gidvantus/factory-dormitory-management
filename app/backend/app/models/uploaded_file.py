"""Реестр загруженных файлов: кто и зачем загрузил файл.

Доступ к файлам (`/uploads/*`) по умолчанию ЗАКРЫТ всем: реестр — это учёт, а
не право. Право чтения считает `app/file_access.can_read` по связям файла
(в CRM такая связь одна — импорт «Размещение персонала» ссылается на файл
колонкой `import_jobs.file_key`) и по членству в организации, которой
принадлежит общежитие импорта. Владелец загрузки (`uploader_kind`,
`uploader_id`) и назначение (`purpose`) нужны для разбора и диагностики, но
сами по себе файл не открывают.

`key` — ключ внутри хранилища БЕЗ префикса `uploads/`, например
`2026-10-29/ab12cd.xlsx` (тот же ключ принимает `app.storage`).
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UploadedFile(Base):
    __tablename__ = "uploaded_file"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True, index=True)
    # Тип аккаунта загрузившего: в CRM аккаунт один — `user` (NULL — служебная
    # загрузка, у которой нет автора).
    uploader_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    uploader_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    # Назначение загрузки (`places_import` и появляющиеся виды файлов).
    purpose: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
