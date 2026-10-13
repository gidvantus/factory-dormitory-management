"""Три тарифа публичного прайса: Старт, Стандарт, Максимум.

Прайс — это данные, а не код: страница `/pricing` читает опубликованные строки
таблицы `tariffs`. Кабинет тарифы больше не правит (редактор прайса снят вместе
с его ручками в issue #34), поэтому стартовый прайс заводится миграцией — иначе
публичная страница остаётся пустой до появления потока покупки.

Заводим ровно три плана, которые просил владелец: месяц до 10 пользователей,
полгода до 15 и год без ограничений. Ограничение по пользователям живёт в
`description`, а не в `unit_label`: `unit_label` подставляется в `price_label`,
и в кабинете тот же текст показался бы второй раз отдельной строкой.

Вставка идемпотентна: если тариф с таким именем уже есть (например, его завели
на стенде руками), строка не дублируется и не перезаписывается.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030_pricing_plans"
down_revision: str | None = "0029_tariff_half_year"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Имена планов: по ним же откат убирает ровно то, что добавил этот `upgrade`.
PLAN_NAMES = ("Старт", "Стандарт", "Максимум")

PLANS: tuple[dict[str, object], ...] = (
    {
        "name": "Старт",
        "description": "До 10 пользователей. Реестр проживающих, комнаты и базовые отчёты.",
        "amount": "10000.00",
        "period": "month",
        "position": 1,
    },
    {
        "name": "Стандарт",
        "description": "До 15 пользователей. Все разделы, расширенная отчётность и статистика.",
        "amount": "50000.00",
        "period": "half_year",
        "position": 2,
    },
    {
        "name": "Максимум",
        "description": "Без ограничений по пользователям. Все разделы и приоритетная поддержка.",
        "amount": "90000.00",
        "period": "year",
        "position": 3,
    },
)

# Идемпотентность держит не `ON CONFLICT`, а проверка имён перед вставкой: имя
# тарифа уникально, но миграция не должна падать на стенде, где строку с таким
# именем уже завели вручную.
#
# Параметр встречается в запросе ровно один раз намеренно: `INSERT ... SELECT
# :name ... WHERE NOT EXISTS (... name = :name)` PostgreSQL разбирает до вывода
# типов и на одном и том же параметре в двух местах падает с
# `AmbiguousParameter` («text versus character varying»).
EXISTING_NAMES_SQL = sa.text("SELECT name FROM tariffs")

INSERT_PLAN_SQL = sa.text(
    """
    INSERT INTO tariffs (name, description, amount, currency, period, position, is_visible)
    VALUES (:name, :description, :amount, 'RUB', :period, :position, true)
    """
)

DELETE_PLAN_SQL = sa.text("DELETE FROM tariffs WHERE name = :name")


def upgrade() -> None:
    connection = op.get_bind()
    existing = set(connection.execute(EXISTING_NAMES_SQL).scalars())
    for plan in PLANS:
        if plan["name"] in existing:
            continue
        connection.execute(INSERT_PLAN_SQL, plan)


def downgrade() -> None:
    op.get_bind().execute(DELETE_PLAN_SQL, [{"name": name} for name in PLAN_NAMES])
