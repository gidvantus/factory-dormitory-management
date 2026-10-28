"""Прайс «ярусы × срок»: четыре яруса по три периода.

Публичная страница `/pricing` читает прайс из базы, а кабинет тарифы не правит
(редактор снят в #34), поэтому новый прайс — это данные, заведённые миграцией.
Сетка: Старт / Рост / Команда / Безлимит, у каждого яруса месяц, квартал и год.
Скидки к месячной цене — 10% за квартал и 20% за год, с округлением до сотен.

**Старые строки не удаляются.** Три строки `0030_pricing_plans` (`Старт`,
`Стандарт`, `Максимум`) переводятся в `is_visible = false`: у организаций, которым
они уже назначены, привязка остаётся видимой (см. docstring `Tariff`), а
выставленные счета ссылаются на них по `id` и хранят снимок названия. Удаление
сломало бы и то, и другое.

**Почему у старого «Старта» меняется имя.** Колонка `name` уникальна, а новая
сетка заводит свою строку «Старт» — месячную строку яруса. Двум строкам с одним
именем в таблице не ужиться, поэтому скрытая старая строка получает имя
«Старт (прежний прайс)». Это единственное изменение данных скрытой строки: цена,
период и порядок у неё остаются прежними, а счета хранят снимок своего названия
и от переименования не страдают. «Стандарт» и «Максимум» не переименовываются —
их имена свободны.

Имя строки яруса: у месячной это просто название яруса, у остальных к нему
добавлен срок («Старт · 3 месяца»). `group_code` связывает три строки одного
яруса, `position` = номер яруса × 10 + номер периода, `max_members` — предел мест
яруса (`NULL` у «Безлимита»), `tooltip` — подсказка к карточке.

Идемпотентность: все шаги защищены условием по `group_code` — новые строки его
заполняют, старые нет. Поэтому повторный `upgrade` после обрыва не переименует
новую строку и не спрячет её. `ON CONFLICT` не используется: имя — не единственная
защита, а проверка перед вставкой повторяет приём `0030`.

Откат удаляет ровно двенадцать новых строк (по `group_code`), возвращает старым
строкам видимость и прежнее имя «Старт». Счета и привязки организаций к новым
строкам откат теряет — `tariff_id` у них обнулится по `ON DELETE SET NULL`;
именно поэтому откат и не трогает старые строки.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0052_tariff_prices"
down_revision: str | None = "0051_subscription_slots"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Прежний «Старт» уступает имя новой месячной строке яруса.
ARCHIVED_START_NAME = "Старт (прежний прайс)"

# Старые строки `0030_pricing_plans`, которые остаются в таблице, но уходят из
# публичного прайса. Имя — то, которое у строки после переименования.
OLD_NAMES = (ARCHIVED_START_NAME, "Стандарт", "Максимум")

# Подсказка к карточке: что считается местом. У безлимитного яруса она про
# отсутствие предела, а не про места.
SEATS_TOOLTIP = "Место — сотрудник с доступом к кабинету. Проживающие не считаются."
UNLIMITED_TOOLTIP = "Сотрудников с доступом к кабинету — без ограничения. Проживающие не считаются."

# Сетка прайса: ярус, предел мест, подсказка и цены за месяц, квартал и год.
TIERS: tuple[dict[str, object], ...] = (
    {
        "group_code": "start",
        "name": "Старт",
        "description": "Реестр проживающих, комнаты и места, базовые отчёты.",
        "max_members": 5,
        "tooltip": SEATS_TOOLTIP,
        "prices": {"month": "4900.00", "quarter": "13200.00", "year": "47000.00"},
    },
    {
        "group_code": "growth",
        "name": "Рост",
        "description": "Все разделы, расширенная отчётность и статистика.",
        "max_members": 15,
        "tooltip": SEATS_TOOLTIP,
        "prices": {"month": "9900.00", "quarter": "26700.00", "year": "95000.00"},
    },
    {
        "group_code": "team",
        "name": "Команда",
        "description": "Все разделы, несколько общежитий и отчёты по каждому.",
        "max_members": 30,
        "tooltip": SEATS_TOOLTIP,
        "prices": {"month": "14900.00", "quarter": "40200.00", "year": "143000.00"},
    },
    {
        "group_code": "unlimited",
        "name": "Безлимит",
        "description": "Все разделы без ограничения по сотрудникам.",
        "max_members": None,
        "tooltip": UNLIMITED_TOOLTIP,
        "prices": {"month": "19900.00", "quarter": "53700.00", "year": "191000.00"},
    },
)

# Периоды внутри яруса: порядковый номер и подпись имени строки.
PERIODS: tuple[tuple[int, str, str | None], ...] = (
    (1, "month", None),
    (2, "quarter", "3 месяца"),
    (3, "year", "12 месяцев"),
)


def _plan(
    tier: dict[str, object], period: str, suffix: str | None, position: int
) -> dict[str, object]:
    """Строка прайса одного яруса за один срок: имя, порядок и цена."""
    prices = tier["prices"]
    assert isinstance(prices, dict)
    base_name = str(tier["name"])
    return {
        "name": base_name if suffix is None else f"{base_name} · {suffix}",
        "description": tier["description"],
        "amount": prices[period],
        "currency": "RUB",
        "period": period,
        "position": position,
        "group_code": tier["group_code"],
        "max_members": tier["max_members"],
        "tooltip": tier["tooltip"],
    }


# Двенадцать строк сетки, собираются из ярусов и периодов: имя, порядок и цена.
PLANS: tuple[dict[str, object], ...] = tuple(
    _plan(tier, period, suffix, tier_index * 10 + period_index)
    for tier_index, tier in enumerate(TIERS, start=1)
    for period_index, period, suffix in PERIODS
)

EXISTING_NAMES_SQL = sa.text("SELECT name FROM tariffs")

INSERT_PLAN_SQL = sa.text(
    """
    INSERT INTO tariffs (name, description, amount, currency, period, position,
                         group_code, max_members, tooltip, is_visible)
    VALUES (:name, :description, :amount, :currency, :period, :position,
            :group_code, :max_members, :tooltip, true)
    """
)

RENAME_OLD_START_SQL = sa.text(
    "UPDATE tariffs SET name = :new_name WHERE name = 'Старт' AND group_code IS NULL"
)

HIDE_OLD_SQL = sa.text(
    "UPDATE tariffs SET is_visible = false WHERE name = :name AND group_code IS NULL"
)

SHOW_OLD_SQL = sa.text(
    "UPDATE tariffs SET is_visible = true WHERE name = :name AND group_code IS NULL"
)

RESTORE_OLD_START_SQL = sa.text("UPDATE tariffs SET name = 'Старт' WHERE name = :archived_name")

DELETE_NEW_SQL = sa.text("DELETE FROM tariffs WHERE name = :name AND group_code IS NOT NULL")


def upgrade() -> None:
    connection = op.get_bind()
    # Старый «Старт» уступает имя месячной строке нового яруса, а `group_code`
    # различает старые и новые строки: у старых он `NULL`.
    connection.execute(RENAME_OLD_START_SQL, {"new_name": ARCHIVED_START_NAME})
    for name in OLD_NAMES:
        connection.execute(HIDE_OLD_SQL, {"name": name})

    existing = set(connection.execute(EXISTING_NAMES_SQL).scalars())
    for plan in PLANS:
        if plan["name"] in existing:
            continue
        connection.execute(INSERT_PLAN_SQL, plan)


def downgrade() -> None:
    connection = op.get_bind()
    for plan in PLANS:
        connection.execute(DELETE_NEW_SQL, {"name": plan["name"]})
    for name in OLD_NAMES:
        connection.execute(SHOW_OLD_SQL, {"name": name})
    connection.execute(RESTORE_OLD_START_SQL, {"archived_name": ARCHIVED_START_NAME})
