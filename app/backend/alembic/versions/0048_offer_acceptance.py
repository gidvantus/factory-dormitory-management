"""Акцепт оферты при покупке тарифа: четыре колонки в `invoices`.

Оферта уже есть документом в таблице `documents` с кодом `offer`
(`0017_documents`). До этой ревизии факт согласия с ней нигде не оседал: человек
нажимал «Купить», счёт выставлялся, и ответить на вопрос «когда и на какую
редакцию он согласился» было нечем.

**Снимок, а не ссылка на живую строку.** Здесь лежит то, что было верно в момент
нажатия: момент акцепта (`offer_accepted_at`), код документа
(`offer_document_code`) и редакция документа на этот момент
(`offer_document_updated_at`, снимок `documents.updated_at`). Код документа
неизменен; редакция — снимок, потому что текст оферты со временем правится, и
вопрос «на какую редакцию согласились» должен отвечаться прошедшим временем.
Автор акцепта — `offer_accepted_by`, внешний ключ на `users.id` с
`ON DELETE SET NULL`: удаление пользователя не должно ни удалять счёт, ни
препятствовать удалению (у счетов уже есть та же политика у `tariff_id` и
`solution_id`).

**`nullable=True` и backfill не делается — намеренно.** Существующие счета
остаются с `NULL` во всех четырёх колонках, и это честно означает «акцепта нет»:
до этой задачи отметки при покупке не спрашивали, и записать задним числом
согласие, которого никто не давал, значило бы подделать доказательство. Поэтому
же в задаче нет блокировки оплаты таких счетов: `NULL` — исторический факт, а не
признак нарушения.

**Вторая пара полей, а не общая таблица акцептов.** Шаблон в проекте уже есть —
`users.consent_at` / `consent_document_code` / `consent_document_updated_at`
(`0039_consent`) и `users.terms_*` (`0047_terms_acceptance`). Акцепт оферты
относится не к человеку, а к сделке: согласие даётся применительно к конкретному
счёту, поэтому поля лежат в `invoices`, а не в `users`. Механизм при этом тот же:
момент, код документа и снимок редакции.

**Модель `documents.offer` не трогается.** Текст оферты — юридический документ, и
правит его человек отдельной ревизией или SQL-запросом.

**Голова дерева.** План называл эту ревизию `0045_offer_acceptance` — он писался,
когда голова была там. К моменту работы поверх `0044_audit_actor_name` уже легли
`0045_organization_root_objects`, `0046_dashboard_per_organization` и
`0047_terms_acceptance`, поэтому ревизия — `0048` с
`down_revision = "0047_terms_acceptance"`.

`upgrade()` идемпотентен (`IF NOT EXISTS`): повторный запуск после обрыва не
падает. Внешний ключ объявлен прямо в `ADD COLUMN` — так `IF NOT EXISTS`
покрывает и его, и отдельный `DO $$ ... ADD CONSTRAINT` не нужен.
`batch_alter_table` не используется: PostgreSQL умеет `ADD COLUMN` без пересборки
таблицы.

**Необратимое.** `downgrade` снимает четыре колонки вместе со всеми записанными
акцептами: другого места у них нет. После появления настоящих акцептов откат
допустим только с их потерей — то же ограничение, что у `0047` и `0039`.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0048_offer_acceptance"
down_revision: str | None = "0047_terms_acceptance"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Порядок важен только при снятии: снимаем снимок редакции, потом код, потом
# автора и момент — чтобы обрыв посреди `downgrade` не оставил пару без пары.
ADD_COLUMNS_SQL = (
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS offer_accepted_at TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS offer_document_code VARCHAR(50)",
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS offer_document_updated_at "
    "TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS offer_accepted_by INTEGER "
    "REFERENCES users(id) ON DELETE SET NULL",
)

DROP_COLUMNS_SQL = (
    "ALTER TABLE invoices DROP COLUMN IF EXISTS offer_document_updated_at",
    "ALTER TABLE invoices DROP COLUMN IF EXISTS offer_document_code",
    "ALTER TABLE invoices DROP COLUMN IF EXISTS offer_accepted_by",
    "ALTER TABLE invoices DROP COLUMN IF EXISTS offer_accepted_at",
)


def upgrade() -> None:
    # `DEFAULT` не задаётся и backfill не делается: у прежних счетов остаётся
    # `NULL`, то есть «акцепта нет» — согласие задним числом не дописывается.
    for statement in ADD_COLUMNS_SQL:
        op.execute(sa.text(statement))


def downgrade() -> None:
    # Записанные акцепты при этом теряются — другого места у них нет.
    for statement in DROP_COLUMNS_SQL:
        op.execute(sa.text(statement))
