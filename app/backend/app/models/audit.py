"""Журнал действий: строка на каждый коммит write-запроса и на каждый отказ.

Строку собирает контекст запроса (`app.main` + `app.audit`) и кладёт её в тот же
коммит, что и само действие (а если коммита не было — пишет после ответа).
Модель нужна для чтения строк тестами и будущим экраном журнала.

Внешних ключей на `users` и `organizations` нет намеренно: журнал не должен
мешать удалять пользователя или организацию и не должен уносить строки за ними.
`actor_id` и `organization_id` — просто числа, которые остаются осмысленными и
после удаления.

На PostgreSQL таблица партиционирована по месяцам, а её первичный ключ составной
— `PRIMARY KEY (id, created_at)` (`alembic/versions/0036_audit_events.py`). Здесь
ни партиций, ни составного ключа нет: юнит-тесты идут на SQLite, где партиций не
существует, а колонка в составном первичном ключе не автоинкрементится. Схема
`public` тоже объявлена только в миграции: SQLite в тестах её не знает, а на
PostgreSQL неквалифицированное имя и так разрешается через `search_path`. Оба
расхождения описаны в докстроке миграции — она источник истины для прод-схемы.

Тело запроса лежит в `request_body` уже очищенным: секреты вырезаны
(`app.audit.redact`), персональные данные заменены маской и отпечатком
(`app.audit.mask`), тело обрезано (`app.audit.truncate`).
"""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, BigInteger, DateTime, Index, Integer, SmallInteger, String, desc, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# Имена индексов совпадают с миграцией: прод-схему собирает она, а не эта модель.
CREATED_INDEX = "ix_audit_events_created_at_id"
ACTOR_INDEX = "ix_audit_events_actor_created_at"
KIND_INDEX = "ix_audit_events_kind_created_at"


class AuditEvent(Base):
    """Строка журнала действий."""

    __tablename__ = "audit_events"
    __table_args__ = (
        # Основной порядок чтения журнала: свежие сверху.
        Index(CREATED_INDEX, desc("created_at"), desc("id")),
        Index(ACTOR_INDEX, "actor_id", desc("created_at")),
        Index(KIND_INDEX, "kind", desc("created_at")),
    )

    # `BigInteger` с вариантом `Integer` для SQLite: там автоинкремент работает
    # только у колонки, объявленной как INTEGER PRIMARY KEY.
    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Кто и от имени какой организации действовал. NULL — запрос без сессии:
    # вход, регистрация, восстановление пароля.
    actor_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    organization_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # `path` — шаблон маршрута (`/api/dormitories/{dormitory_id}`), а не адрес с
    # подставленным идентификатором: иначе журнал нельзя группировать.
    method: Mapped[str] = mapped_column(String(8), nullable=False)
    path: Mapped[str] = mapped_column(String(512), nullable=False)
    # Код действия для группировки. Читаемое название берётся из `ACTION_TITLES`
    # (`app/audit.py`) и хранится не здесь: иначе переименование действия
    # задним числом переписывало бы уже собранный журнал.
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    # Как закончился запрос. У атомарной строки (той, что уходит коммитом самого
    # действия) эти поля пустые: на момент коммита финальный код ответа ещё
    # неизвестен. Их заполняет только строка, записанная после ответа.
    status: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(200), nullable=True)
    request_body: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    path_params: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
