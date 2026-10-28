"""Настройки яруса тарифа и квартальный период оплаты.

Две вещи одной ревизией, потому что обе описывают одну и ту же строку прайса:

* **настройки яруса.** `tariffs` получает `max_members` (сколько сотрудников,
  кроме владельца, допускает тариф; `NULL` — без ограничения), `tooltip`
  (подсказка к карточке) и `group_code` (машинный код яруса: строки одного
  яруса с разным сроком делят его). `name`, `description`, `amount`, `period`,
  `is_visible` и `position` уже есть и правятся данными — второго поля срока не
  заводим, иначе два источника срока разойдутся;
* **период `quarter`.** Прайс продаёт подписку ещё и на квартал, а `CHECK` на
  `period` перечисляет допустимые значения. Набор периодов у тарифов и у решений
  магазина общий (`SOLUTION_PERIODS = TARIFF_PERIODS`), поэтому ограничение
  расширяется в двух таблицах: `tariffs.ck_tariffs_period` и
  `solutions.ck_solutions_period`. `half_year` не удаляется: на нём стоит уже
  проданный «Стандарт».

Существующие строки остаются как есть: новые колонки nullable, backfill им не
нужен — безлимит, отсутствие подсказки и «ярус не размечен» это нормальные
состояния, а не незаполненная форма.

Откат снимает три колонки и возвращает прежний набор периодов. Значения `CHECK`
записаны прямо в SQL: ревизия должна читаться и исполняться без импорта
приложения, иначе правка кода задним числом меняет смысл выпущенного шага.
Откат возможен лишь после того, как из обеих таблиц уйдут строки с `quarter`:
`CHECK` проверяет существующие строки при создании и молча оставить
несовместимые данные не даст. Это тот же осознанный компромисс, что у
`0029_tariff_half_year`.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0050_tariff_settings"
down_revision: str | None = "0049_solution_journal"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Колонки, которые заводит ревизия. Проверяются тестом на совпадение с моделью.
ADD_COLUMNS_SQL = (
    "ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS max_members INTEGER",
    "ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS tooltip VARCHAR(200)",
    "ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS group_code VARCHAR(40)",
)

# Откат снимает ровно добавленное и в обратном порядке.
DROP_COLUMNS_SQL = (
    "ALTER TABLE tariffs DROP COLUMN IF EXISTS group_code",
    "ALTER TABLE tariffs DROP COLUMN IF EXISTS tooltip",
    "ALTER TABLE tariffs DROP COLUMN IF EXISTS max_members",
)

# Наборы периодов: прежний (после `0029_tariff_half_year`) и новый с кварталом.
OLD_PERIODS_SQL = "'month', 'year', 'once', 'half_year'"
NEW_PERIODS_SQL = "'month', 'quarter', 'half_year', 'year', 'once'"

# Таблица и имя ограничения: набор периодов у тарифов и решений общий, поэтому
# расширяется в двух таблицах сразу.
PERIOD_CHECKS = (
    ("tariffs", "ck_tariffs_period"),
    ("solutions", "ck_solutions_period"),
)


def _replace_period_checks(values_sql: str) -> None:
    for table, constraint in PERIOD_CHECKS:
        op.drop_constraint(constraint, table, type_="check")
        op.create_check_constraint(constraint, table, f"period IN ({values_sql})")


def upgrade() -> None:
    for statement in ADD_COLUMNS_SQL:
        op.execute(statement)
    _replace_period_checks(NEW_PERIODS_SQL)


def downgrade() -> None:
    _replace_period_checks(OLD_PERIODS_SQL)
    for statement in DROP_COLUMNS_SQL:
        op.execute(statement)
