"""Журнал действий — вторая строка каталога магазина улучшений (решение `journal`).

Механизм платных решений уже выпущен ревизией `0035_solutions`: каталог
(`solutions`), право организации (`organization_solutions`), зависимость
`require_solution` и покупка существующим счётом. Эта ревизия не меняет схему —
она заводит **данные**: строку каталога «Журнал действий», которую продают
отдельно, как «Уведомления в Telegram».

Раньше журнал был бесплатным разделом уровня владельца. Теперь это обычное
решение каталога: цена 300 ₽ в месяц, период `month`, порядок — второй, сразу под
Telegram. Грандфазера нет намеренно — у организаций без права журнал перестаёт
открываться в день выката, как было с Telegram в #61.

**Идемпотентность.** Вставка проверяет существующие коды отдельным запросом, как
`0035_solutions`: параметр встречается в `INSERT` ровно один раз, иначе PostgreSQL
разбирает запрос до вывода типов и падает с `AmbiguousParameter`. Поэтому
повторный `upgrade` после обрыва не падает и вторую строку не плодит.

**Откат.** `downgrade()` удаляет ровно строку `code = 'journal'` и не трогает
ничего больше: Telegram, счета, тарифы и выданные прежде права остаются. Строка
каталога аддитивна, но у неё есть следствия: `organization_solutions` и
`invoices.solution_id` ссылаются на неё (права — `ON DELETE CASCADE`, счета —
`ON DELETE SET NULL`). Откат поэтому теряет выданные права на журнал, а уже
выставленные счета за него — ссылку на предмет: снимок названия и периода в
`tariff_name`/`tariff_period` остаётся, и счёт читается.

Значения записаны прямо в SQL, а не взяты из `app.models.solution` или
`app.solutions`: ревизия должна читаться и исполняться без импорта приложения,
иначе правка кода задним числом меняет смысл уже выпущенного шага.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0049_solution_journal"
down_revision: str | None = "0048_offer_acceptance"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Строка каталога, которую заводит эта ревизия. Поля повторяют seed `0035`:
# `code` — код решения (он же в `app.solutions.JOURNAL`), `position = 2` ставит
# журнал сразу под Telegram, `is_visible` — строка показывается в магазине.
SEED = {
    "code": "journal",
    "name": "Журнал действий",
    "description": "Кто, когда и что изменил в кабинете",
    "amount": "300.00",
    "currency": "RUB",
    "period": "month",
    "position": 2,
}

EXISTING_CODES_SQL = sa.text("SELECT code FROM solutions")

INSERT_SOLUTION_SQL = sa.text(
    """
    INSERT INTO solutions (code, name, description, amount, currency, period, position, is_visible)
    VALUES (:code, :name, :description, :amount, :currency, :period, :position, true)
    """
)

DELETE_SOLUTION_SQL = sa.text("DELETE FROM solutions WHERE code = :code")


def upgrade() -> None:
    connection = op.get_bind()
    existing = set(connection.execute(EXISTING_CODES_SQL).scalars())
    if SEED["code"] not in existing:
        connection.execute(INSERT_SOLUTION_SQL, SEED)


def downgrade() -> None:
    # Ровно одна строка по коду: остальные решения каталога, счета, тарифы и
    # выданные права откат не трогает.
    op.get_bind().execute(DELETE_SOLUTION_SQL, {"code": SEED["code"]})
