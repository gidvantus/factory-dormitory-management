"""Схемы публичных документов сервиса."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class DocumentSummary(BaseModel):
    """Строка списка документов: подвал и оглавление обходятся без текста."""

    model_config = ConfigDict(from_attributes=True)

    code: str
    title: str


class DocumentResponse(BaseModel):
    """Документ целиком: текст отдаётся как есть, разметки в нём нет."""

    model_config = ConfigDict(from_attributes=True)

    code: str
    title: str
    body: str
    updated_at: datetime
