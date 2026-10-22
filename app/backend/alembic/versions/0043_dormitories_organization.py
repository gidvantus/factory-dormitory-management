"""Принадлежность общежития организации.

Корень данных кабинета — `dormitories`: на `dormitory_id` висят все операционные
таблицы. Поэтому принадлежность считается здесь, одной колонкой, а не
денормализуется в каждую дочернюю таблицу.

Ссылка `ON DELETE RESTRICT`, а не `SET NULL`: удаление организации не должно
молча прятать её общежития — оно обязано упереться в ограничение.

Заполнение существующих строк идёт по данным об авторе общежития
(`dormitories.created_by_id` → `users.active_organization_id`). Общежитие, у
которого автора привязать нечем (автор удалён или у него нет активной
организации), привязать невозможно: миграция **останавливается** с перечнем
таких `id` и не ставит `NOT NULL`. Судьбу остатка решает владелец данных, а не
миграция: молча удалить или спрятать эти общежития было бы потерей данных.
"""

import sqlalchemy as sa
from alembic import op

revision = "0043_dormitories_organization"
down_revision = "0042_merge_develop_s"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Колонка заводится nullable: на существующих строках её ещё нет, а backfill
    # зависит от данных об авторе.
    op.execute(
        "ALTER TABLE dormitories ADD COLUMN IF NOT EXISTS organization_id INTEGER "
        "REFERENCES organizations(id) ON DELETE RESTRICT"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_dormitories_organization_id ON dormitories (organization_id)")
    op.execute(
        "UPDATE dormitories d SET organization_id = u.active_organization_id "
        "FROM users u "
        "WHERE u.id = d.created_by_id "
        "AND u.active_organization_id IS NOT NULL "
        "AND d.organization_id IS NULL"
    )

    # Fail-loud: остаток привязать нечем, и решение о нём — не дело миграции.
    orphans = [
        row[0]
        for row in op.get_bind()
        .execute(sa.text("SELECT id FROM dormitories WHERE organization_id IS NULL ORDER BY id"))
        .all()
    ]
    if orphans:
        raise RuntimeError(
            "Общежития без организации: "
            + ", ".join(str(item) for item in orphans)
            + ". Привяжите их к организации или удалите, затем повторите миграцию: "
            "organization_id остаётся nullable, NOT NULL не ставится."
        )

    op.alter_column("dormitories", "organization_id", existing_type=sa.Integer(), nullable=False)


def downgrade() -> None:
    op.alter_column("dormitories", "organization_id", existing_type=sa.Integer(), nullable=True)
    op.execute("DROP INDEX IF EXISTS ix_dormitories_organization_id")
    op.execute("ALTER TABLE dormitories DROP COLUMN IF EXISTS organization_id")
