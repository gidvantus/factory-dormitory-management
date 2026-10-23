"""Раскладка и блоки дашборда становятся объектами организации.

Задача T3 эпика #78 (issue #82). До этой ревизии `dashboard_layout` был
синглтоном (`id = 1`, засеян `0021_dashboard_blocks`), а `dashboard_blocks` —
общей таблицей: одна организация видела и правила блоки другой, а лимит «до 100
блоков» считался по всей таблице. Здесь у обеих таблиц появляется
`organization_id` — по образцу `dormitories.organization_id` из `0043` и
корневых объектов из `0045`.

**`nullable=True` — правило, а не компромисс.** `NULL` значит «не принадлежит
никому и не виден ни одной организации»; `NOT NULL` не ставится ни в модели, ни
здесь, потому что остаток привязать нечем, а удалять данные миграция не имеет
права.

**Backfill идёт по текущей организации автора** (`created_by_id` →
`users.active_organization_id`) — другой точки правды у старых блоков нет.
Следствие прямое: сотрудник, перешедший в другую организацию, уносит свои блоки
с собой. Блок, который привязать нечем (автор удалён или у него нет организации),
остаётся с `organization_id IS NULL` и невидим навсегда.

**Legacy-синглтон копируется каждой организации.** Прежний общий порядок и
скрытые карточки — единственное, что было настроено на всю систему; читаем
строку `id = 1` и для каждой организации вставляем свою раскладку: встроенные
карточки на своих местах, ключи `custom:<id>` чужих блоков выпадают, ключи
собственных блоков встают в конец. Порядок, настроенный одной организацией после
миграции, никуда не копируется.

**`downgrade` не восстанавливает прежний порядок.** Раскладки были скопированы из
одной общей, поэтому какая из них «исходная» — вопрос без ответа: откат удаляет
раскладки организаций, вставляет синглтон `id = 1` с порядком по умолчанию и
пустым `hidden` и снимает колонки. Настроенный порядок любой из организаций
теряется — это названо здесь, а не обнаружено на откате.

Операции идемпотентны (`IF NOT EXISTS`, проверка по `pg_constraint`), автогенерация
не используется: `unique=True` в модели и ограничение в базе alembic видит
по-разному.
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0046_dashboard_per_organization"
down_revision: str | None = "0045_organization_root_objects"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Копия `DEFAULT_DASHBOARD_ORDER` из `app.models.dashboard_block`: миграция не
# импортирует модели (они меняются вместе с кодом, а ревизия — нет), а
# совпадение сторожит `tests/test_dashboard_per_organization_migration.py`.
DEFAULT_ORDER = ["residents", "turnover", "attendance", "reports"]

CUSTOM_PREFIX = "custom:"

# Backfill — единственная необратимая запись ревизии, поэтому его SQL вынесен в
# константу: тот же текст выполняет `tests/test_dashboard_per_organization_migration.py`
# против настоящей PostgreSQL. Правило в тесте не переписывается — иначе опечатка
# здесь (join не по `created_by_id`, снятое `active_organization_id IS NOT NULL`)
# прошла бы мимо проверки и молча спрятала блоки от всех.
BACKFILL_SQL = (
    "UPDATE dashboard_blocks b SET organization_id = u.active_organization_id "
    "FROM users u "
    "WHERE u.id = b.created_by_id "
    "AND u.active_organization_id IS NOT NULL "
    "AND b.organization_id IS NULL"
)

LAYOUT_UNIQUE = "dashboard_layout_organization_id_key"
BLOCKS_INDEX = "ix_dashboard_blocks_organization_id"


def scoped_layout(
    order: list[str], hidden: list[str], own_keys: list[str]
) -> tuple[list[str], list[str]]:
    """Раскладка одной организации из прежней общей.

    Встроенные карточки остаются на своих местах, ключи `custom:<id>` чужих и
    осиротевших блоков выпадают, ключи собственных блоков дописываются в конец,
    если их в прежнем порядке не было. `hidden` фильтруется тем же правилом, и
    потому всегда остаётся подмножеством `order`.
    """
    own = set(own_keys)

    def keeps(key: str) -> bool:
        return not key.startswith(CUSTOM_PREFIX) or key in own

    scoped_order = [key for key in order if keeps(key)]
    scoped_order.extend(key for key in own_keys if key not in scoped_order)
    scoped_hidden = [key for key in hidden if keeps(key)]
    return scoped_order, scoped_hidden


def upgrade() -> None:
    op.execute(
        "ALTER TABLE dashboard_layout ADD COLUMN IF NOT EXISTS organization_id INTEGER "
        "REFERENCES organizations(id) ON DELETE CASCADE"
    )
    op.execute(
        "ALTER TABLE dashboard_blocks ADD COLUMN IF NOT EXISTS organization_id INTEGER "
        "REFERENCES organizations(id) ON DELETE RESTRICT"
    )
    op.execute(f"CREATE INDEX IF NOT EXISTS {BLOCKS_INDEX} ON dashboard_blocks (organization_id)")
    # Уникальность раскладки внутри организации. Postgres не сравнивает NULL,
    # поэтому строки без организации этому ограничению не мешают.
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = '{LAYOUT_UNIQUE}' AND conrelid = 'dashboard_layout'::regclass
            ) THEN
                ALTER TABLE dashboard_layout
                ADD CONSTRAINT {LAYOUT_UNIQUE} UNIQUE (organization_id);
            END IF;
        END
        $$;
        """
    )
    op.execute(BACKFILL_SQL)
    _copy_legacy_layout()


def downgrade() -> None:
    frame = op.get_bind()
    op.execute("DELETE FROM dashboard_layout WHERE organization_id IS NOT NULL")
    # Прежний синглтон возвращается с порядком по умолчанию: чей из раскладок
    # организаций считать исходным — вопрос без ответа (см. docstring).
    frame.execute(
        sa.text(
            'INSERT INTO dashboard_layout (id, revision, "order", hidden) '
            "SELECT 1, 0, CAST(:order AS json), CAST('[]' AS json) "
            "WHERE NOT EXISTS (SELECT 1 FROM dashboard_layout WHERE id = 1)"
        ),
        {"order": json.dumps(DEFAULT_ORDER)},
    )
    op.execute(f"ALTER TABLE dashboard_layout DROP CONSTRAINT IF EXISTS {LAYOUT_UNIQUE}")
    op.execute(f"DROP INDEX IF EXISTS {BLOCKS_INDEX}")
    op.execute("ALTER TABLE dashboard_blocks DROP COLUMN IF EXISTS organization_id")
    op.execute("ALTER TABLE dashboard_layout DROP COLUMN IF EXISTS organization_id")


def _copy_legacy_layout() -> None:
    """Разложить прежний общий порядок карточек по организациям."""
    frame = op.get_bind()
    legacy = frame.execute(
        sa.text('SELECT "order", hidden FROM dashboard_layout WHERE id = 1')
    ).first()
    if legacy is None:
        order, hidden = list(DEFAULT_ORDER), []
    else:
        order, hidden = list(legacy[0] or []), list(legacy[1] or [])
    blocks = frame.execute(
        sa.text("SELECT id, organization_id FROM dashboard_blocks ORDER BY id")
    ).all()
    # Синглтон уходит до вставки: его `id = 1` — первый свободный номер, и
    # вставка раскладки первой организации иначе упёрлась бы в PRIMARY KEY.
    frame.execute(sa.text("DELETE FROM dashboard_layout WHERE id = 1"))
    organizations = frame.execute(sa.text("SELECT id FROM organizations ORDER BY id")).scalars()
    for organization_id in organizations:
        own_keys = [
            f"{CUSTOM_PREFIX}{block_id}"
            for block_id, block_organization_id in blocks
            if block_organization_id == organization_id
        ]
        scoped_order, scoped_hidden = scoped_layout(order, hidden, own_keys)
        frame.execute(
            sa.text(
                'INSERT INTO dashboard_layout (organization_id, revision, "order", hidden) '
                "VALUES (:organization_id, 0, CAST(:order AS json), CAST(:hidden AS json))"
            ),
            {
                "organization_id": organization_id,
                "order": json.dumps(scoped_order),
                "hidden": json.dumps(scoped_hidden),
            },
        )
