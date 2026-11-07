"""Реквизиты поставщика `company_details` и засев строки (issue #179).

Блок «Поставщик» в печатных формах счёта и акта был заглушкой: реквизитов
поставщика в проекте не было вовсе. Теперь они живут в таблице `company_details`
и правятся оператором в кабинете — без деплоя и без правки кода.

**Почему одна строка.** Поставщик в проекте один — сам сервис; справочника
контрагентов нет и не планируется. Строгость выражения — `CHECK (id = 1)` с
именем `ck_company_details_single_row`: правило держит база, а не ручка. Колонка
`id` нужна ради `PRIMARY KEY`, а не ради множества строк.

**Засев.** Ревизия заводит ровно одну строку: `id = 1`, все реквизиты `NULL`,
`vat_note = 'НДС не облагается'`. Формулировка взята из Vahta, где она же стоит
по умолчанию. Пустые реквизиты — честное «данных пока нет»: печатная форма
печатает заглушку, а не прочерки вместо названия и банка. Строка нужна затем,
чтобы `PATCH` было что менять: создания строки в API нет.

**Откат снимает таблицу целиком** — вместе с заполненными реквизитами. На стенде
`alembic downgrade` не применяется (`docs/ci.md`): восстановление из дампа, как
и у любой миграции этого проекта.

Засев защищён `NOT EXISTS` по строке: повторный прогон шага после обрыва не
задвоит её (хотя `PRIMARY KEY` и так не дал бы, `NOT EXISTS` делает шаг
идемпотентным целиком, а не падающим).

Все SQL — константами модуля: их разбирает `tests/test_company_details_migration.py`.
Идентификатор ревизии короче 32 символов (`varchar(32)` у `version_num`).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0067_company_details"
down_revision: str | None = "0066_invoice_items"

branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE_NAME = "company_details"
SINGLE_ROW_CHECK = "ck_company_details_single_row"

# Строка одна: второй поставщик в проекте не планируется.
SINGLE_ROW_CONDITION_SQL = "id = 1"

# Идентификатор единственной строки.
SINGLE_ROW_ID = 1

# Формулировка по умолчанию. Это данные, попадающие в печатные документы:
# режим другой — оператор правит строку в кабинете, а очистка убирает её из формы.
DEFAULT_VAT_NOTE = "НДС не облагается"

# Засев: одна строка с пустыми реквизитами и заполненной строкой про НДС.
# `NOT EXISTS` делает шаг идемпотентным при повторном прогоне после обрыва.
SEED_SQL = sa.text(
    f"""
    INSERT INTO {TABLE_NAME} (id, vat_note)
    SELECT {SINGLE_ROW_ID}, '{DEFAULT_VAT_NOTE}'
    WHERE NOT EXISTS (SELECT 1 FROM {TABLE_NAME} WHERE id = {SINGLE_ROW_ID})
    """
)


def upgrade() -> None:
    op.create_table(
        TABLE_NAME,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=True),
        sa.Column("inn", sa.String(12), nullable=True),
        sa.Column("kpp", sa.String(9), nullable=True),
        sa.Column("ogrn", sa.String(15), nullable=True),
        sa.Column("address", sa.String(500), nullable=True),
        sa.Column("bank_name", sa.String(255), nullable=True),
        sa.Column("bank_bic", sa.String(9), nullable=True),
        sa.Column("bank_account", sa.String(20), nullable=True),
        sa.Column("corr_account", sa.String(20), nullable=True),
        sa.Column("signatory", sa.String(300), nullable=True),
        sa.Column("vat_note", sa.String(200), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(SINGLE_ROW_CONDITION_SQL, name=SINGLE_ROW_CHECK),
    )
    op.execute(SEED_SQL)


def downgrade() -> None:
    # Таблица снимается целиком вместе с единственной строкой: отдельных
    # `drop_index`/`drop_constraint` нет — `drop_table` снимает и то, и другое.
    op.drop_table(TABLE_NAME)
