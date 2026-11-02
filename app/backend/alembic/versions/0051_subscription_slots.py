"""Слоты подписки организации: срок текущего тарифа и оплата вперёд.

`organizations` получает три колонки:

* `tariff_ends_at` — конец текущего оплаченного периода. Граница **исключающая**,
  как `users.trial_ends_at`: в этот момент тариф уже не действует;
* `next_tariff_id` — тариф, оплаченный вперёд (`REFERENCES tariffs(id) ON DELETE
  SET NULL`, как у `tariff_id`: удаление строки прайса не ломает организацию);
* `next_tariff_ends_at` — конец будущего периода. Дня начала у слота нет
  намеренно: будущий период начинается ровно в `tariff_ends_at` текущего, и
  второе поле разошлось бы с первым.

Индекс `ix_organizations_next_tariff_id` заводится здесь же: в модели колонка
объявлена с `index=True`, и схема базы обязана совпадать с моделью.

**Backfill обязателен.** Без него у всех уже проданных тарифов `tariff_ends_at`
остался бы `NULL`, а `NULL` в этом поле означает бессрочный тариф: кабинеты
продолжили бы работать. Вопрос в другом — с какого момента считать срок, ведь
дата оплаты в `organizations` не хранится. Считаем от момента выкатки: месяц,
квартал, полгода или год текущего тарифа вперёд, по его `period`. Так никто не
теряет оплаченное, и все получают одинаковый срок на переходный период.
Период `once` (и незнакомый) остаётся бессрочным: `NULL` — это и есть его смысл.

Откат снимает три колонки. `tariff_ends_at` при этом теряется вместе с ней, а
подписка возвращается к состоянию «тариф выбран, срок не считается» — то, что
было до ревизии. `tariff_id` и `next_tariff_id` откат не трогает: терять
оплаченный тариф из-за откатов схемы нельзя, а ссылка на будущий период просто
перестаёт читаться.

Backfill написан на Python, а не на SQL: месяцы считаются той же арифметикой, что
в приложении (усечение на конце месяца), и шаг одинаково работает на PostgreSQL и
на SQLite, поэтому проверяется тестом на синтетической схеме, а не только руками
на стенде.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`.
"""

import calendar
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "0051_subscription_slots"
down_revision: str | None = "0050_tariff_settings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ADD_COLUMNS_SQL = (
    "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tariff_ends_at TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS next_tariff_id INTEGER "
    "REFERENCES tariffs(id) ON DELETE SET NULL",
    "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS next_tariff_ends_at "
    "TIMESTAMP WITH TIME ZONE",
)

DROP_COLUMNS_SQL = (
    "ALTER TABLE organizations DROP COLUMN IF EXISTS next_tariff_ends_at",
    "ALTER TABLE organizations DROP COLUMN IF EXISTS next_tariff_id",
    "ALTER TABLE organizations DROP COLUMN IF EXISTS tariff_ends_at",
)

# Индекс на `next_tariff_id` объявлен в модели (`index=True`), поэтому его обязана
# завести и ревизия: иначе схема боевой базы расходится с моделью, `ON DELETE SET
# NULL` при удалении строки прайса идёт по `organizations` без индекса, а следующая
# автогенерация предлагает «создать уже объявленный индекс». Имя — то, которое
# SQLAlchemy выводит из таблицы и колонки; у `tariff_id` такой же (`0018`).
CREATE_INDEX_SQL = (
    "CREATE INDEX IF NOT EXISTS ix_organizations_next_tariff_id ON organizations (next_tariff_id)"
)

DROP_INDEX_SQL = "DROP INDEX IF EXISTS ix_organizations_next_tariff_id"

# Сколько календарных месяцев прибавляет период. `once` здесь нет: он даёт
# бессрочный тариф, и `NULL` в `tariff_ends_at` — правильное состояние.
MONTHS_BY_PERIOD = {"month": 1, "quarter": 3, "half_year": 6, "year": 12}

SELECT_SOLD_TARIFFS_SQL = sa.text(
    """
    SELECT organizations.id AS organization_id, tariffs.period AS period
    FROM organizations
    JOIN tariffs ON tariffs.id = organizations.tariff_id
    WHERE organizations.tariff_ends_at IS NULL
    """
)

UPDATE_END_SQL = sa.text(
    "UPDATE organizations SET tariff_ends_at = :ends_at WHERE id = :organization_id"
)


def _add_months(moment: datetime, months: int) -> datetime:
    """Прибавить календарные месяцы с усечением на конце месяца.

    31 января плюс месяц — 28 или 29 февраля, а не 3 марта: срок не должен
    удлиняться из-за того, что в месяце меньше дней.
    """
    total = moment.month - 1 + months
    year = moment.year + total // 12
    month = total % 12 + 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def backfill_tariff_ends_at(connection: sa.Connection, now: datetime | None = None) -> None:
    """Проставить срок уже проданным тарифам: момент выкатки плюс их период."""
    moment = now or datetime.now(UTC)
    for organization_id, period in connection.execute(SELECT_SOLD_TARIFFS_SQL).all():
        months = MONTHS_BY_PERIOD.get(str(period))
        if months is None:
            # `once` продаётся бессрочно: `NULL` и есть его срок.
            continue
        connection.execute(
            UPDATE_END_SQL,
            {"ends_at": _add_months(moment, months), "organization_id": organization_id},
        )


def upgrade() -> None:
    for statement in ADD_COLUMNS_SQL:
        op.execute(statement)
    op.execute(CREATE_INDEX_SQL)
    backfill_tariff_ends_at(op.get_bind())


def downgrade() -> None:
    op.execute(DROP_INDEX_SQL)
    for statement in DROP_COLUMNS_SQL:
        op.execute(statement)
