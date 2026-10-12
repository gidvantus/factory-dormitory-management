"""Пробный период: колонка `users.trial_ends_at`.

Ревизия аддитивная: у пользователя появляется дата окончания пробного периода,
данные не пересеиваются. Колонка nullable — у неактивированного кабинета
пробного периода нет вовсе, и это нормальное состояние, а не пропуск.

Существующим активированным пользователям дата заполняется одним `UPDATE`:
они уже работают в кабинете, и после выкатки у них должен остаться месяц
пробного периода, а не мгновенная блокировка. Пер-строчная логика в Python
здесь не нужна и только замедлила бы миграцию.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.

Номер ревизии взят по фактической голове `develop-m`: план issue просил
`0025_trial_period` от `0024_merge_develop_s`, но к моменту работы над задачей
на ветке уже стояли `0025_documents` и `0026_organization_requisites`. При
слиянии с `develop-m` к ним добавилась `0027_import_jobs` (задача #38), поэтому
ревизия сдвинута на `0028` и идёт следом за ней: две головы от `0026` сломали бы
`alembic upgrade head`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0028_trial_period"
down_revision: str | None = "0027_import_jobs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Длительность пробного периода прямо в SQL: та же величина, что
# `Settings.trial_days` по умолчанию, но у миграции нет доступа к настройкам.
BACKFILL_TRIAL_SQL = """
    UPDATE users
    SET trial_ends_at = now() + interval '30 days'
    WHERE is_active = true AND trial_ends_at IS NULL
"""


def upgrade() -> None:
    op.add_column("users", sa.Column("trial_ends_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(BACKFILL_TRIAL_SQL)


def downgrade() -> None:
    op.drop_column("users", "trial_ends_at")
