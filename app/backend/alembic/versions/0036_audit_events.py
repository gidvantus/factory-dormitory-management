"""Журнал действий: партиционированная по месяцам таблица `audit_events`.

Задача, в которой родилась ревизия, называла её `0032_audit_events` с
`down_revision = "0031_invoices"`. К моменту работы голова alembic ушла вперёд:
поверх `0031_invoices` уже стоят `0032_telegram_notifications`, `0033_merge_develop_s`,
`0034_merge_telegram` и `0035_solutions`. Поэтому ревизия — `0036_audit_events` с
`down_revision = "0035_solutions"`: вторая голова в дереве недопустима.

**Расхождение модели и прод-схемы.** Модель `app.models.audit.AuditEvent` —
обычная таблица с `PRIMARY KEY (id)` и без партиций, и это не ошибка:

* партиционирование умеет только PostgreSQL, а юнит-тесты идут на SQLite, где
  `PARTITION BY` — синтаксическая ошибка;
* SQLite не автоинкрементит колонку, входящую в составной первичный ключ, так
  что `PRIMARY KEY (id, created_at)` сломала бы вставку в тестах;
* схему `public` модель не объявляет: SQLite её не знает, а на PostgreSQL
  неквалифицированное имя и так разрешается через `search_path`.

Прод-схему собирает **эта ревизия**, а не модель. Автогенерация здесь не
используется: `op.create_table` не умеет `PARTITION BY`, поэтому SQL написан
руками. Если следующая ревизия будет сгенерирована автоматически, alembic
увидит расхождение модели и базы и предложит пересоздать таблицу — этого делать
нельзя, иначе пропадут партиции и весь журнал.

**Почему месячные партиции.** Журнал растёт на гигабайты в месяц, а хранится
разное время: два года для действий безопасности и квартал для остальных.
Отбросить старый месяц вместе с его партицией (`DROP TABLE`) дешевле, чем
удалять строки построчно, и не распухает таблица.

Партиции заводятся на текущий и следующие `audit_partitions_ahead` (12) месяцев
— тем же набором, что и на старте приложения (`app.audit.ensure_partitions`), —
плюс `DEFAULT`-партиция. Она нужна как страховка: журнал пишется в том же
коммите, что и действие, поэтому пропущенный месяц без `DEFAULT` означал бы не
потерянную строку, а отказ write-ручки. Строка в `DEFAULT` не теряется, но
`app.audit.warn_about_default_rows` пишет о ней WARNING: пока она там, месячная
партиция её диапазона не создастся. Значение периода продублировано здесь числом,
а не взято из настроек: миграция должна читаться и исполняться без импорта
приложения, иначе правка настроек задним числом меняет смысл выпущенной ревизии.

`status` и `duration_ms` объявлены nullable: у строки, которая уходит коммитом
самого действия, финальный код ответа и длительность ещё неизвестны. Их
заполняет только строка, записанная после ответа (вход, выход, отказы).

`upgrade()` идемпотентен (`IF NOT EXISTS`): повторный запуск после обрыва не
падает. `downgrade()` уносит таблицу целиком — вместе с ней уходят все партиции,
индексы и последовательность `id`.
"""

from collections.abc import Sequence
from datetime import UTC, date, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "0036_audit_events"
down_revision: str | None = "0035_solutions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "public"
TABLE = "audit_events"
AHEAD_MONTHS = 12

# Имена совпадают с моделью (`app.models.audit`) и с запросами чтения журнала:
# свежие строки, строки одного актора, строки одного вида.
INDEXES: tuple[tuple[str, str], ...] = (
    ("ix_audit_events_created_at_id", "(created_at DESC, id DESC)"),
    ("ix_audit_events_actor_created_at", "(actor_id, created_at DESC)"),
    ("ix_audit_events_kind_created_at", "(kind, created_at DESC)"),
)

# `BIGSERIAL`, а не `IDENTITY`: партиции наследуют умолчание родителя, включая
# `nextval`, поэтому вставка через ORM (без id) работает и в партицию.
#
# `PRIMARY KEY (id, created_at)` — требование PostgreSQL: в первичный ключ
# партиционированной таблицы обязана входить колонка разбиения. Внешних ключей
# на `users` и `organizations` нет намеренно: журнал не должен мешать удалять
# пользователя и не должен уносить строки за организацией.
CREATE_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {SCHEMA}.{TABLE} (
    id BIGSERIAL NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id INTEGER,
    organization_id INTEGER,
    method VARCHAR(8) NOT NULL,
    path VARCHAR(512) NOT NULL,
    action VARCHAR(64) NOT NULL,
    kind VARCHAR(8) NOT NULL,
    status SMALLINT,
    duration_ms INTEGER,
    ip VARCHAR(45),
    user_agent VARCHAR(200),
    request_body JSON,
    path_params JSON,
    request_id VARCHAR(36),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at)
"""

CREATE_PARTITION_SQL = (
    "CREATE TABLE IF NOT EXISTS {name} PARTITION OF {schema}.{table} "
    "FOR VALUES FROM ('{start}') TO ('{end}')"
)

CREATE_DEFAULT_PARTITION_SQL = (
    "CREATE TABLE IF NOT EXISTS {name} PARTITION OF {schema}.{table} DEFAULT"
)

DROP_TABLE_SQL = f"DROP TABLE IF EXISTS {SCHEMA}.{TABLE}"

# `DEFAULT`-партиция — страховка от пропущенного месяца. С ней строка журнала
# ложится в общую партицию, а `app.audit.warn_about_default_rows` пишет WARNING;
# без неё вставка падает, а так как журнал пишется в коммите самого действия,
# клиент получает отказ. Ошибка в расписании партиций не должна останавливать
# работу кабинета.
DEFAULT_PARTITION_SUFFIX = "default"


def month_start(moment: datetime) -> date:
    """Первое число месяца момента в UTC — граница партиции."""
    return moment.astimezone(UTC).date().replace(day=1)


def shift_month(month: date, offset: int) -> date:
    """Первое число месяца через `offset` месяцев."""
    total = month.year * 12 + month.month - 1 + offset
    return date(total // 12, total % 12 + 1, 1)


def partition_name(month: date) -> str:
    """Имя партиции месяца: `audit_events_2026_10`."""
    return f"{TABLE}_{month.year:04d}_{month.month:02d}"


def default_partition_name() -> str:
    """Имя `DEFAULT`-партиции журнала."""
    return f"{TABLE}_{DEFAULT_PARTITION_SUFFIX}"


def partition_plan(now: datetime) -> list[tuple[str, date, date]]:
    """Партиции на текущий и следующие `AHEAD_MONTHS` месяцев."""
    current = month_start(now)
    return [
        (
            partition_name(month),
            month,
            shift_month(month, 1),
        )
        for month in (shift_month(current, offset) for offset in range(AHEAD_MONTHS + 1))
    ]


def upgrade() -> None:
    op.execute(sa.text(CREATE_TABLE_SQL))
    for name, columns in INDEXES:
        op.execute(sa.text(f"CREATE INDEX IF NOT EXISTS {name} ON {SCHEMA}.{TABLE} {columns}"))
    op.execute(
        sa.text(
            CREATE_DEFAULT_PARTITION_SQL.format(
                name=default_partition_name(),
                schema=SCHEMA,
                table=TABLE,
            )
        )
    )
    for name, start, end in partition_plan(datetime.now(UTC)):
        # Имя и границы собраны из календаря, а не из ввода: подставлять в DDL
        # пользовательские значения здесь нечему.
        op.execute(
            sa.text(
                CREATE_PARTITION_SQL.format(
                    name=name,
                    schema=SCHEMA,
                    table=TABLE,
                    start=start.isoformat(),
                    end=end.isoformat(),
                )
            )
        )


def downgrade() -> None:
    # Партиции, индексы и последовательность уходят вместе с родительской таблицей.
    op.execute(sa.text(DROP_TABLE_SQL))
