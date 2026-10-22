"""Схемы чтения журнала действий (`GET /api/journal`).

Ручка только читает: строки собирает middleware и слушатель коммита
(`app.audit`), поэтому здесь нет ни одной схемы запроса на запись — кроме
параметров фильтра.

Форма записи повторяет колонки `audit_events` один в один. Читаемое название
действия (`action_title`) в базе не хранится, а берётся из `app.audit` в момент
ответа: иначе переименование действия задним числом переписывало бы уже
собранный журнал.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

# Виды действий. Значения те же, что `app.audit.AUDIT_KINDS`; `Literal` нужен,
# чтобы FastAPI объявил перечисление в схеме и отклонил чужое значение с 422.
JournalKind = Literal["security", "data", "noise"]


class JournalEntry(BaseModel):
    """Одна запись журнала.

    `status` и `duration_ms` пустые у строк, которые ушли коммитом самого
    действия: на момент коммита финальный код ответа ещё неизвестен. Поэтому
    оба поля `| None`, и клиент показывает прочерк.

    `actor_id` — идентификатор, а не ФИО: журнал не должен уносить данные вслед
    за удалённым пользователем, а внешних ключей в таблице нет намеренно.
    """

    id: int
    created_at: datetime
    actor_id: int | None
    method: str
    path: str
    action: str
    action_title: str
    kind: JournalKind
    status: int | None
    duration_ms: int | None
    ip: str | None
    user_agent: str | None
    request_id: str | None
    # Значения подставленного пути (`{"dormitory_id": "42"}`) — чтобы запись
    # можно было понять, не открывая тело запроса.
    path_params: dict[str, Any] | None
    # Тело запроса и снимок «было → стало» уже очищены при записи: секреты
    # заменены, персональные данные замаскированы, значения обрезаны
    # (`app.audit.redact` / `mask` / `truncate`). Тело бывает и не объектом
    # (JSON-массив, число), поэтому `Any`.
    request_body: Any | None
    changes: list[dict[str, Any]] | None


class JournalPage(BaseModel):
    """Страница ленты журнала: свежие записи сверху и курсор следующей.

    `next_cursor` = `None` означает, что записей больше нет. Курсор
    непрозрачен для клиента: его формат (`<created_at ISO>|<id>`) — деталь
    сервера, и собирать его самостоятельно фронт не должен.
    """

    items: list[JournalEntry] = Field(default_factory=list)
    next_cursor: str | None
