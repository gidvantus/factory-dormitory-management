"""Прайс из двух лицензий: 6 и 12 месяцев, и цена места 1 500 ₽ (issue #177).

Витрина продаёт ровно две лицензии — «Домовой · 6 месяцев» и «Домовой ·
12 месяцев», у каждой своя цена и своё включённое число сотрудников. Прежняя
сетка `0052_tariff_prices` (4 яруса × 3 срока) уходит из витрины флагом
`is_visible = false`.

**Строки не удаляются.** На строки прайса ссылаются привязки организаций
(`organizations.tariff_id`, `organizations.next_tariff_id`) и счета
(`invoices.tariff_id`, `invoice_items.tariff_id`): удаление обнулило бы ссылки
по `ON DELETE SET NULL` и лишило бы организацию действующего тарифа. Витрина
отсекает только `is_visible`, а привязка от него не зависит — организация с
назначенным вручную ярусом продолжает работать (см. docstring `Tariff`).

Что делает ревизия:

* вставляет две строки `tariffs` с `group_code = 'license'`, если строк с такими
  именами ещё нет. Вставка идемпотентна по имени, как у `0052`: повторный прогон
  шага после обрыва не падает на `UNIQUE(name)` и второй строки не плодит;
* прячет прежние ярусы `start`, `growth`, `team`, `unlimited`. Исторические
  строки «Старт (прежний прайс)», «Стандарт» и «Максимум» у `0052` имеют
  `group_code IS NULL`, поэтому условие по `group_code` их не задевает — ни
  здесь, ни в откате;
* приводит цену места к 1 500 ₽: строку `solutions` с кодом `extra_member`
  сеет `0064_extra_seats` с ценой 900 ₽, и повышение цены — решение этой задачи.
  Если строки нет, `UPDATE` не падает и ничего не создаёт: отсутствие строки —
  поломка #168, а не повод сеять её заново с другой ценой.

`tooltip` новых лицензий — тот же текст про место, что у ярусов `0052`: место
считается по сотрудникам с доступом к кабинету, проживающие не считаются.

**Откат** снимает две строки по `group_code = 'license'`, возвращает видимость
ярусам по тому же `group_code` и цену места 900 ₽. Исторические строки с
`group_code IS NULL` откат не трогает: они и не прятались этим шагом.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`. Родитель — фактическая голова `develop-m` после мержа
#168 (`0064_extra_seats`), а не номер из постановки.

Все SQL — константами модуля: их разбирает `tests/test_license_prices_migration.py`.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0065_license_prices"
down_revision: str | None = "0064_extra_seats"

branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Код яруса новых лицензий: по нему строки витрины отличаются от прежней сетки и
# по нему же откат снимает ровно их.
LICENSE_GROUP_CODE = "license"

# Прежние ярусы, которые уходят из витрины. Строки остаются в таблице: на них
# стоят привязки организаций и ссылки счетов.
TIER_GROUP_CODES_SQL = "'start', 'growth', 'team', 'unlimited'"

# Подсказка к карточке: что считается местом. Тот же текст, что у ярусов `0052`.
SEATS_TOOLTIP = "Место — сотрудник с доступом к кабинету. Проживающие не считаются."

# Две лицензии витрины. `position` задаёт порядок карточек: 6 месяцев, затем 12.
LICENSES: tuple[dict[str, object], ...] = (
    {
        "name": "Домовой · 6 месяцев",
        "description": "Лицензия на 6 месяцев: до 5 сотрудников включено",
        "amount": "60000.00",
        "currency": "RUB",
        "period": "half_year",
        "position": 1,
        "group_code": LICENSE_GROUP_CODE,
        "max_members": 5,
        "tooltip": SEATS_TOOLTIP,
    },
    {
        "name": "Домовой · 12 месяцев",
        "description": "Лицензия на 12 месяцев: до 10 сотрудников включено",
        "amount": "100000.00",
        "currency": "RUB",
        "period": "year",
        "position": 2,
        "group_code": LICENSE_GROUP_CODE,
        "max_members": 10,
        "tooltip": SEATS_TOOLTIP,
    },
)

# Имена уже заведённых строк: по ним решается, вставлять лицензию или нет.
EXISTING_NAMES_SQL = sa.text("SELECT name FROM tariffs")

INSERT_LICENSE_SQL = sa.text(
    """
    INSERT INTO tariffs (name, description, amount, currency, period, position,
                         group_code, max_members, tooltip, is_visible)
    VALUES (:name, :description, :amount, :currency, :period, :position,
            :group_code, :max_members, :tooltip, true)
    """
)

# Витрина: прежние ярусы скрываются, обратный шаг возвращает видимость. Условие
# по `group_code` не задевает исторические строки с `group_code IS NULL`.
HIDE_TIERS_SQL = sa.text(
    f"UPDATE tariffs SET is_visible = false WHERE group_code IN ({TIER_GROUP_CODES_SQL})"
)
SHOW_TIERS_SQL = sa.text(
    f"UPDATE tariffs SET is_visible = true WHERE group_code IN ({TIER_GROUP_CODES_SQL})"
)

DELETE_LICENSES_SQL = sa.text(f"DELETE FROM tariffs WHERE group_code = '{LICENSE_GROUP_CODE}'")

# Цена места: 900 ₽ из #168 → 1 500 ₽. Обратный шаг возвращает 900 ₽.
EXTRA_MEMBER_RAISE_SQL = sa.text(
    "UPDATE solutions SET amount = 1500.00 WHERE code = 'extra_member'"
)
EXTRA_MEMBER_RESTORE_SQL = sa.text(
    "UPDATE solutions SET amount = 900.00 WHERE code = 'extra_member'"
)


def upgrade() -> None:
    connection = op.get_bind()
    existing = set(connection.execute(EXISTING_NAMES_SQL).scalars())
    for license_row in LICENSES:
        if license_row["name"] in existing:
            continue
        connection.execute(INSERT_LICENSE_SQL, license_row)
    connection.execute(HIDE_TIERS_SQL)
    connection.execute(EXTRA_MEMBER_RAISE_SQL)


def downgrade() -> None:
    # Порядок обратный: строки лицензий снимаются первыми (на них могут стоять
    # ссылки счетов — `SET NULL` обнулит их), затем возвращается витрина и цена.
    connection = op.get_bind()
    connection.execute(DELETE_LICENSES_SQL)
    connection.execute(SHOW_TIERS_SQL)
    connection.execute(EXTRA_MEMBER_RESTORE_SQL)
