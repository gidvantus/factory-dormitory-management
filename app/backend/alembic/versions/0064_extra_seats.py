"""Докупка мест сверх тарифа: счётчик организации и предмет счёта за места.

Предел приглашений был равен `tariffs.max_members` действующего тарифа
(`app/subscription.py`), а пополнить его было нечем: `invoices.item_kind` знал
только `tariff` и `solution`, у решения не было количества, у счёта — поля
количества. Эта ревизия заводит всё, из чего складывается покупка мест:

* **`organizations.extra_seats`** — докупленные места организации. `NOT NULL
  DEFAULT 0`: у существующих организаций мест не докуплено, и это честный ноль,
  а не «неизвестно». Место живёт вместе с подпиской — отдельного срока у него
  нет, при продлении тарифа он остаётся, к ярусу не привязан;
* **`invoices.quantity`** — количество мест в счёте. `NULL` у всех исторических
  счетов и у счетов за тариф и за решение: там количество неприменимо, а не
  «один». У счёта за места оно всегда `> 0` — это держит `CHECK`
  `ck_invoices_quantity_positive`;
* **`ck_invoices_item_kind`** расширяется третьим видом предмета `seats`. Набор
  пересобирается тем же приёмом, что периоды в `0050_tariff_settings`:
  `op.drop_constraint` + `op.create_check_constraint`. В модели тот же набор
  объявляет `INVOICE_ITEM_KINDS`, поэтому список записан в двух местах
  одинаково — как у статусов и ролей;
* **строка каталога `solutions`** «Дополнительные сотрудники» (код
  `extra_member`, 900 ₽, период `once`, порядок 900). Период `once` — «место
  живёт вместе с подпиской»: разовый платёж без собственного срока. Порядок 900
  ставит карточку после прежних решений магазина.

**Вставка идемпотентна по коду.** `solutions.name` уникален, поэтому повторный
прогон шага после обрыва упал бы на `UNIQUE`, а не на дубле. Вставка идёт одним
`INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM solutions WHERE code =
'extra_member')`: имя кода повторяется в запросе ровно один раз, чтобы PostgreSQL
не упёрся в `AmbiguousParameter`, как в `0049_solution_journal`. Модуль объявляет
SQL константами: их разбирает `tests/test_seats_migration.py`.

**Откат** снимает строку каталога по коду, возвращает прежний `CHECK`
(`'tariff', 'solution'`), снимает `CHECK` на количество и обе колонки. Счета за
места откат не удаляет — они остаются историческим фактом, но пройти прежний
`CHECK` не смогут, поэтому откат возможен только пока таких счетов нет: это тот
же осознанный компромисс, что у `0050_tariff_settings`. Уже оплаченные места при
откате теряются (счётчик обнуляется, счета и суммы остаются) — это цена возврата
схемы на шаг назад.

Идентификатор ревизии короче 32 символов: колонка `alembic_version.version_num`
имеет тип `varchar(32)`. Номер `0064`, а не `0061` из постановки: `0061`–`0063`
заняты ревизиями, приехавшими в `develop-m` позже текста задачи
(`0061_merge_local_notifications`, `0062_table_views` и сводящая головы
`0063_merge_main_heads`). Родитель — сводящая ревизия, а не `0062_table_views`
напрямую: без неё дерево остаётся с двумя головами, и `alembic upgrade head`
падает с `Multiple head revisions`. Идентификаторы не перенумеровываются: alembic
идёт по `down_revision`, а не по номеру в имени.

**Сводящая ревизия — не своя, а из ветки инструментов миграций (#174, #175).**
`0063_merge_main_heads` сводит ту же пару голов (`0062_table_views`,
`0060_merge_stand_heads`), которая понадобилась этой ветке, и лежит здесь
**байт-в-байт** тем же файлом (blob `ac8ee4a`): две разные сводящие ревизии из
одних и тех же родителей дают ровно ту развилку, которую проект уже проходил на
`0058_merge_alembic_heads` / `0058_merge_main_heads` — после слияния веток в
дереве оказались бы две головы и `alembic upgrade head` упал бы. Одинаковый файл
git сводит без конфликта в любом порядке слияния.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0064_extra_seats"
down_revision: str | None = "0063_merge_main_heads"

branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Колонки, которые заводит ревизия. Проверяются тестом на совпадение с моделью.
ADD_COLUMNS_SQL = (
    "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS extra_seats INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quantity INTEGER",
)

# Откат снимает ровно добавленное и в обратном порядке.
DROP_COLUMNS_SQL = (
    "ALTER TABLE invoices DROP COLUMN IF EXISTS quantity",
    "ALTER TABLE organizations DROP COLUMN IF EXISTS extra_seats",
)

# Таблица и имя ограничения на вид предмета счёта: набор расширяется тем же
# приёмом, что периоды в `0050_tariff_settings`.
ITEM_KIND_TABLE = "invoices"
ITEM_KIND_CHECK = "ck_invoices_item_kind"

# Прежний и новый наборы видов предмета счёта.
OLD_ITEM_KINDS_SQL = "'tariff', 'solution'"
NEW_ITEM_KINDS_SQL = "'tariff', 'solution', 'seats'"

UPGRADE_ITEM_KIND_SQL = f"item_kind IN ({NEW_ITEM_KINDS_SQL})"
DOWNGRADE_ITEM_KIND_SQL = f"item_kind IN ({OLD_ITEM_KINDS_SQL})"

# Количество мест в счёте: `NULL` — «неприменимо» (тариф, решение, исторические
# счета), у счёта за места — всегда положительное.
QUANTITY_CHECK = "ck_invoices_quantity_positive"
QUANTITY_CHECK_SQL = "quantity IS NULL OR quantity > 0"

# Строка каталога магазина улучшений, которую заводит ревизия. Значения записаны
# прямо в SQL, а не взяты из `app.seats`: ревизия должна читаться и исполняться
# без импорта приложения, иначе правка кода задним числом меняет смысл шага.
SEED_EXTRA_MEMBER_SQL = """
    INSERT INTO solutions (code, name, description, amount, currency, period, position, is_visible)
    SELECT 'extra_member',
           'Дополнительные сотрудники',
           'Каждый дополнительный сотрудник сверх мест тарифа. Место живёт вместе с подпиской.',
           900.00,
           'RUB',
           'once',
           900,
           true
    WHERE NOT EXISTS (SELECT 1 FROM solutions WHERE code = 'extra_member')
"""

DELETE_EXTRA_MEMBER_SQL = "DELETE FROM solutions WHERE code = 'extra_member'"


def _replace_item_kind_check(values_sql: str) -> None:
    op.drop_constraint(ITEM_KIND_CHECK, ITEM_KIND_TABLE, type_="check")
    op.create_check_constraint(ITEM_KIND_CHECK, ITEM_KIND_TABLE, values_sql)


def upgrade() -> None:
    for statement in ADD_COLUMNS_SQL:
        op.execute(statement)
    op.create_check_constraint(QUANTITY_CHECK, ITEM_KIND_TABLE, QUANTITY_CHECK_SQL)
    _replace_item_kind_check(UPGRADE_ITEM_KIND_SQL)
    op.execute(SEED_EXTRA_MEMBER_SQL)


def downgrade() -> None:
    # Строка каталога снимается первой: на неё ссылаются `invoices.solution_id`
    # (`SET NULL` обнулит ссылку) и права на решения.
    op.execute(DELETE_EXTRA_MEMBER_SQL)
    _replace_item_kind_check(DOWNGRADE_ITEM_KIND_SQL)
    op.drop_constraint(QUANTITY_CHECK, ITEM_KIND_TABLE, type_="check")
    for statement in DROP_COLUMNS_SQL:
        op.execute(statement)
