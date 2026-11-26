"""Схемы платформенного журнала (`GET /api/platform/journal`).

Строка та же, что у клиентского журнала (`app.schemas.audit.JournalEntry`), плюс
организация, из которой пришло действие. Имя организации добирается отдельным
запросом по `id` страницы (`app/api/platform_journal.py`), а не join внутри общего
правила выборки.

`organization_id = null` - строка платформенного контура (вход, регистрация,
восстановление пароля): отдаётся в ленте, имени у неё нет.
"""

from pydantic import BaseModel, Field

from app.schemas.audit import JournalEntry


class PlatformJournalEntry(JournalEntry):
    """Строка журнала всех организаций.

    `organization_name = null` и у строки платформенного контура, и у строки, чья
    организация удалена: клиент показывает первое как «Платформа», второе - приглушённо.
    """

    organization_id: int | None
    organization_name: str | None


class PlatformJournalPage(BaseModel):
    """Страница платформенной ленты: та же семантика курсора и `total`, что у клиентской."""

    items: list[PlatformJournalEntry] = Field(default_factory=list)
    next_cursor: str | None
    total: int | None
