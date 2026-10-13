"""Полугодовой период оплаты тарифа.

Прайс продаёт подписку не только на месяц или год, но и на полгода: `CHECK` на
колонке `period` перечисляет допустимые значения, поэтому без расширения
ограничения строка с `half_year` в таблицу не вставится. Ревизия только меняет
ограничение: колонка, её тип и данные не трогаются.

Откат возвращает прежний список значений и потому возможен лишь после того, как
из таблицы уйдут строки с `half_year` (это делает `downgrade` следующей
ревизии `0030_pricing_plans`). На PostgreSQL это осознанный компромисс: `CHECK`
проверяет существующие строки при создании, и молча оставить несовместимые
данные он не даст.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0029_tariff_half_year"
down_revision: str | None = "0028_trial_period"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Значения записаны прямо в SQL, а не взяты из `app.models.tariff`: миграция
# должна читаться и исполняться без импорта приложения, иначе правка модели
# задним числом меняет смысл уже выпущенной ревизии.
OLD_PERIODS_SQL = "'month', 'year', 'once'"
NEW_PERIODS_SQL = "'month', 'year', 'once', 'half_year'"


def _replace_period_check(values_sql: str) -> None:
    op.drop_constraint("ck_tariffs_period", "tariffs", type_="check")
    op.create_check_constraint("ck_tariffs_period", "tariffs", f"period IN ({values_sql})")


def upgrade() -> None:
    _replace_period_check(NEW_PERIODS_SQL)


def downgrade() -> None:
    _replace_period_check(OLD_PERIODS_SQL)
