"""Принятие правил использования платформой: три колонки в `users`.

Вторая пара колонок рядом с согласием на обработку персональных данных
(`0039_consent`): момент принятия правил, код документа и снимок редакции
документа на этот момент. Согласие и правила — разные документы с разными
основаниями: согласие на обработку данных спрашивается по закону о персональных
данных, правила использования — это договор об условиях работы сервиса. Один
чекбокс не может принимать оба документа, поэтому и учёт у них раздельный.

**Вторая пара, а не общая таблица принятий.** Шаблон в проекте уже есть —
`users.consent_at` / `consent_document_code` / `consent_document_updated_at`.
Отдельная таблица принятий потребовала бы миграции с переносом существующих
согласий и переписывания работающего механизма ради одного нового документа.

**`nullable=True` и backfill не делается.** Существующие пользователи остаются с
`terms_accepted_at IS NULL` — это честно означает «правила не принимал».
Приглашённый сотрудник правил не принимал (аккаунт ему заводит владелец), и
спросит его об этом активация; зарегистрировавшийся через форму принял правила
на регистрации. Уже активированных повторно не спрашивают: токен одноразовый,
второго входа на экран активации у них нет. Это принятое ограничение задачи, а не
дефект ревизии.

**Строка документа `terms-of-use` не трогается.** Она заведена ещё в
`0017_documents`; здесь только колонки пользователя. Текст документа — заготовка,
и правит его человек SQL-запросом или отдельной ревизией.

**Голова дерева.** Задача называла эту ревизию `0045_terms_acceptance` с
`down_revision = "0044_audit_actor_name"` — план писался, когда голова была там.
К моменту работы поверх `0044` уже легли `0045_organization_root_objects` и
`0046_dashboard_per_organization` (#81, #82), поэтому ревизия — `0047` с
`down_revision = "0046_dashboard_per_organization"`. Вторая голова в дереве
недопустима.

`upgrade()` идемпотентен (`IF NOT EXISTS`): повторный запуск после обрыва не
падает. Автогенерация не используется — колонки в модели и в базе alembic видит
по-разному, а `batch_alter_table` на этой таблице не нужен: PostgreSQL умеет
`ADD COLUMN` без пересборки.

**Необратимое.** `downgrade` снимает три колонки вместе со всеми записанными
принятиями правил: другого места у них нет. После появления настоящих принятий
откат допустим только с их потерей.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0047_terms_acceptance"
down_revision: str | None = "0046_dashboard_per_organization"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Порядок важен только при снятии: снимаем снимок редакции, потом код, потом
# момент принятия — чтобы обрыв посреди `downgrade` не оставил пару без пары.
ADD_COLUMNS_SQL = (
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_document_code VARCHAR(50)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_document_updated_at "
    "TIMESTAMP WITH TIME ZONE",
)

DROP_COLUMNS_SQL = (
    "ALTER TABLE users DROP COLUMN IF EXISTS terms_document_updated_at",
    "ALTER TABLE users DROP COLUMN IF EXISTS terms_document_code",
    "ALTER TABLE users DROP COLUMN IF EXISTS terms_accepted_at",
)


def upgrade() -> None:
    # `DEFAULT` не задаётся и backfill не делается: у прежних строк остаётся
    # `NULL`, то есть «правила не принимал».
    for statement in ADD_COLUMNS_SQL:
        op.execute(sa.text(statement))


def downgrade() -> None:
    # Данные принятий при этом теряются — другого места у них нет.
    for statement in DROP_COLUMNS_SQL:
        op.execute(sa.text(statement))
