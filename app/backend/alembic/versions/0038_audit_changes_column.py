"""Журнал действий: колонка `changes` со снимком «было → стало».

Задача, в которой родилась ревизия, называла её `0033_audit_changes_column` с
`down_revision = "0032_audit_events"`. К моменту работы и `0032_audit_events`, и
промежуточные ревизии уже в истории: ревизия журнала стала `0036_audit_events`,
поверх неё лёг merge `0037_merge_develop_s`, и сейчас это голова дерева. Поэтому
здесь `0038_audit_changes_column` с `down_revision = "0037_merge_develop_s"`:
вторая голова в дереве недопустима, а `down_revision` указывает на вершину ветки
предка, в которой заведена таблица журнала.

**Что делает ревизия.** Одна колонка `changes JSON` на партиционированной таблице
`audit_events`. У партиционированной таблицы `ADD COLUMN` — операция уровня
метаданных: колонка наследуется всеми существующими партициями, данные не
переписываются, блокировки строк нет. `DEFAULT` не задаётся: у прежних строк
значение остаётся `NULL`, а `NULL` означает «изменений в коммите не было».

Тип — `JSON`, а не `JSONB`: юнит-тесты создают таблицу из модели на SQLite, где
`JSONB` не существует, а модель объявляет эту же колонку как `JSON`
(`app.models.audit.AuditEvent.changes`). На PostgreSQL `JSON` хранит текст как
есть — журналу этого достаточно: искать по снимку в этой задаче не нужно, читается
он целиком вместе со строкой.

Автогенерация здесь не используется: alembic не знает про партиции и, увидев
расхождение модели и прод-схемы, предложил бы пересоздать таблицу — этого делать
нельзя, иначе пропадут партиции и весь журнал. `upgrade()` идемпотентен
(`IF NOT EXISTS`): повторный запуск после обрыва не падает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0038_audit_changes_column"
down_revision: str | None = "0037_merge_develop_s"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "public"
TABLE = "audit_events"
COLUMN = "changes"

ADD_COLUMN_SQL = f"ALTER TABLE {SCHEMA}.{TABLE} ADD COLUMN IF NOT EXISTS {COLUMN} JSON"

DROP_COLUMN_SQL = f"ALTER TABLE {SCHEMA}.{TABLE} DROP COLUMN IF EXISTS {COLUMN}"


def upgrade() -> None:
    # Колонка наследуется всеми партициями: отдельного `ALTER` на каждую не нужно.
    op.execute(sa.text(ADD_COLUMN_SQL))


def downgrade() -> None:
    # `DROP COLUMN` на партиционированной таблице так же снимает колонку со всех
    # партиций. Данные снимка при этом теряются — другого места у них нет.
    op.execute(sa.text(DROP_COLUMN_SQL))
