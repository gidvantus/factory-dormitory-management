"""Публичные документы сервиса: политика, правила и оферта.

Обе ручки открыты анониму, как `GET /api/health` и `GET /api/tariffs`:
страница `/documents/<code>` доступна без сессии, и в подвале лендинга на неё
ведёт обычная ссылка. Аутентификации здесь нет намеренно — ни `CurrentUser`,
ни `ActiveUser` в зависимостях не объявлены.

Признака публикации у документа нет: всё, что попало в таблицу `documents`,
видно снаружи. Скрыть строку нельзя, а неизвестный код — это 404.

Текст отдаётся как plain text: абзацы разделены пустой строкой, разметку
разбирает клиент, и никакого HTML сервер не собирает.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.document import Document
from app.schemas.document import DocumentResponse, DocumentSummary
from app.schemas.user import ErrorResponse

router = APIRouter(prefix="/documents", tags=["documents"])
DbSession = Annotated[Session, Depends(get_db)]

DOCUMENT_NOT_FOUND_DETAIL = "Документ не найден"

# Код приходит из адреса, а не из формы, но ограничить его длину нужно: без
# этого строка любой длины уходила бы в запрос по индексированной колонке.
DocumentCode = Annotated[str, Path(min_length=1, max_length=50)]

NOT_FOUND_RESPONSE: dict[int | str, dict[str, Any]] = {
    status.HTTP_404_NOT_FOUND: {
        "model": ErrorResponse,
        "description": DOCUMENT_NOT_FOUND_DETAIL,
    },
}


@router.get("", response_model=list[DocumentSummary], summary="Список публичных документов")
def list_documents(db: DbSession) -> list[Document]:
    """Оглавление и подвал: только `code` и `title`, без текста документов."""
    return list(db.scalars(select(Document).order_by(Document.position, Document.code)))


@router.get(
    "/{code}",
    response_model=DocumentResponse,
    summary="Публичный документ по коду",
    responses=NOT_FOUND_RESPONSE,
)
def read_document(code: DocumentCode, db: DbSession) -> Document:
    """Документ целиком. Неизвестный код — 404, а не пустая страница на клиенте."""
    document = db.scalar(select(Document).where(Document.code == code))
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, DOCUMENT_NOT_FOUND_DETAIL)
    return document
