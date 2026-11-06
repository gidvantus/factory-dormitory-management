"""Право на решение действует по тарифу: каталог нормализуется к `period = 'once'` (#195).

У решений магазина больше нет собственного срока: право действует, пока у
организации есть действующий тариф (`app/subscription.py`), а `period` строки
каталога перестал означать срок права. Каталог теперь отдаёт `period = "once"` и
цену «500 ₽ разово» константой (`app/api/solutions.py`), но колонка в базе может
хранить прежние значения: две seed-строки (`0035_solutions` — `month`,
`0049_solution_journal` — `month`) и то, что успел выставить оператор через
кабинет (#188).

Ревизия приводит **все** строки `solutions` к `period = 'once'`: у правила теперь
один источник правды и в коде, и в данных, и никакая строка не может случайно
вернуть решениям собственный срок. Колонка при этом остаётся в схеме — её снятие
(`DROP COLUMN`, необратимо) вынесено в отдельную задачу.

`organization_solutions.expires_at` ревизия **не трогает**. Колонка была сроком
права, а стала историей оплаченных сроков: новый `grant` пишет туда `NULL`, а код
её больше не читает. Удалять историю в миграции, которая иначе полностью
обратима, незачем.

**Откат необратим по строкам.** `downgrade` возвращает `month` двум известным
seed-строкам (`telegram_notifications` и `journal`) — это то состояние, в котором
каталог был до задачи. Значения, которые оператор успел выставить через админку,
восстановить нельзя: ревизия их не сохраняла, а перебирать периоды наугад — хуже,
чем честно оставить `once`. Поэтому `downgrade` трогает только известные коды.

Родитель — фактическая голова `develop-m` (`0067_company_details`), а не номер из
постановки: в дереве есть сводящие ревизии, и вторая голова после этого шага не
появляется (`alembic heads` — одна строка).

Все SQL — константами модуля: их разбирает `tests/test_solutions_tariff_scope_migration.py`.
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0068_solutions_tariff_scope"
down_revision: str | None = "0067_company_details"

branch_labels: str | None = None
depends_on: str | None = None

# Каталог целиком приводится к бессрочному периоду: срок права больше не читается
# из строки каталога, поэтому значение не должно означать ничего другого.
NORMALIZE_PERIOD_SQL = sa.text("UPDATE solutions SET period = 'once' WHERE period <> 'once'")

# Коды seed-строк, которые до задачи были месячными. Откат возвращает период
# только им: значений оператора ревизия не сохраняла.
SEED_CODES_SQL = "'telegram_notifications', 'journal'"

RESTORE_SEED_PERIOD_SQL = sa.text(
    f"UPDATE solutions SET period = 'month' WHERE period = 'once' AND code IN ({SEED_CODES_SQL})"
)


def upgrade() -> None:
    op.get_bind().execute(NORMALIZE_PERIOD_SQL)


def downgrade() -> None:
    op.get_bind().execute(RESTORE_SEED_PERIOD_SQL)
