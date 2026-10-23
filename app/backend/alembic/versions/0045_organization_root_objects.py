"""Три корневых объекта кабинета становятся объектами организации.

Задача T3 эпика #78. У шаблонов структуры (`dormitory_templates`), шаблонов
отчёта (`report_templates`) и сохранённых отчётов статистики
(`statistics_reports`) нет корня-общежития: принадлежность приходилось либо
вычислять по автору, либо не проверять вовсе. Здесь у них появляется своя
колонка `organization_id` — по образцу `dormitories.organization_id` из
`0043_dormitories_organization`.

**`nullable=True` — правило, а не компромисс.** `NULL` означает «объект не виден
никому»: его судьбу решает владелец данных, а не код. Поэтому `NOT NULL` не
ставится ни в модели, ни здесь. Для `dormitories` в `0043` ограничение ставилось
после fail-loud backfill'а; здесь остаток привязывать нечем и удалять его нельзя,
и строка без организации просто перестаёт быть видимой.

**Backfill идёт по текущей организации автора** (`created_by_id` →
`users.active_organization_id`), потому что другой точки правды у старых строк
нет. Следствие прямое: сотрудник, перешедший в другую организацию, уносит свои
шаблоны и отчёты с собой. Строки, которые привязать нечем (автор удалён или у
него нет активной организации), остаются с `organization_id IS NULL` и становятся
невидимыми навсегда. Особенно заметно это у `dormitory_templates`: шаблоны без
автора раньше считались «общими для всех», теперь их не видно никому. Это
намеренная смена поведения, и перед деплоем она требует явного «да» владельца
данных.

**Уникальность имён переезжает внутрь организации.** Глобальные ограничения
`report_templates_name_key` и `dormitory_templates_name_key` снимаются, вместо них
заводится `uq_<таблица>_organization_name` на `(organization_id, name)`: две
организации вправе завести одинаково названные шаблоны. Имена сверены с реальной
базой (`unique=True` в `0004_report_templates` и `0019_dormitory_templates`
Postgres назвал `<таблица>_name_key`).

**`downgrade` может упасть на восстановлении глобального unique**, если после
миграции в разных организациях появились одноимённые шаблоны. Это ожидаемо:
ограничение не глушится и не заменяется «первым попавшимся» — иначе откат молча
потерял бы данные. Перед откатом конфликтующие имена переименовывает владелец
данных.

Операции идемпотентны (`IF NOT EXISTS`, проверки по `pg_constraint`): повторный
запуск после обрыва не падает. Автогенерация не используется: `unique=True` в
старых ревизиях и `UniqueConstraint` в моделях alembic видит по-разному, и вместо
пары `ALTER` он предложил бы пересоздать таблицу.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0045_organization_root_objects"
down_revision: str | None = "0044_audit_actor_name"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Корневые объекты без общего корня-общежития: у них есть своя колонка.
ALL_TABLES = ("report_templates", "dormitory_templates", "statistics_reports")

# Из них только у двух имён была глобальная уникальность — её и меняем.
NAME_TABLES = ("report_templates", "dormitory_templates")

# Backfill — единственная необратимая запись ревизии, поэтому его SQL вынесен в
# константу: тот же текст выполняет `tests/test_organization_root_migration.py`
# против настоящей PostgreSQL. Правило в тесте не переписывается — иначе опечатка
# здесь (join не по `created_by_id`, снятое `active_organization_id IS NOT NULL`)
# прошла бы мимо проверки и молча спрятала строки от всех.
BACKFILL_SQL = (
    "UPDATE {table} t SET organization_id = u.active_organization_id "
    "FROM users u "
    "WHERE u.id = t.created_by_id "
    "AND u.active_organization_id IS NOT NULL "
    "AND t.organization_id IS NULL"
)


def upgrade() -> None:
    for table in ALL_TABLES:
        op.execute(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS organization_id INTEGER "
            "REFERENCES organizations(id) ON DELETE RESTRICT"
        )
        op.execute(
            f"CREATE INDEX IF NOT EXISTS ix_{table}_organization_id ON {table} (organization_id)"
        )
        op.execute(BACKFILL_SQL.format(table=table))
    for table in NAME_TABLES:
        _replace_name_unique(table)


def downgrade() -> None:
    for table in NAME_TABLES:
        _restore_name_unique(table)
    for table in ALL_TABLES:
        op.execute(f"DROP INDEX IF EXISTS ix_{table}_organization_id")
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS organization_id")


def _replace_name_unique(table: str) -> None:
    """Снять глобальный unique на имя и завести уникальность внутри организации."""
    legacy = f"{table}_name_key"
    scoped = f"uq_{table}_organization_name"
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = '{legacy}' AND conrelid = '{table}'::regclass
            ) THEN
                ALTER TABLE {table} DROP CONSTRAINT {legacy};
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = '{scoped}' AND conrelid = '{table}'::regclass
            ) THEN
                ALTER TABLE {table} ADD CONSTRAINT {scoped} UNIQUE (organization_id, name);
            END IF;
        END
        $$;
        """
    )


def _restore_name_unique(table: str) -> None:
    """Обратно: глобальный unique на имя.

    Падает, если в разных организациях уже есть одноимённые шаблоны: глушить
    ограничение нельзя, иначе откат потеряет данные молча.
    """
    legacy = f"{table}_name_key"
    scoped = f"uq_{table}_organization_name"
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = '{scoped}' AND conrelid = '{table}'::regclass
            ) THEN
                ALTER TABLE {table} DROP CONSTRAINT {scoped};
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = '{legacy}' AND conrelid = '{table}'::regclass
            ) THEN
                ALTER TABLE {table} ADD CONSTRAINT {legacy} UNIQUE (name);
            END IF;
        END
        $$;
        """
    )
