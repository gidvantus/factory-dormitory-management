"""Роли участника организации: администратор, менеджер, комендант.

Ревизия только расширяет `CHECK`-констрейнт: набор допустимых значений растёт,
существующие строки не переписываются и не удаляются. Устаревшее `member`
остаётся в перечне намеренно — иначе уже сохранённые строки не прошли бы
проверку, а чтение такой строки отвечало бы 500 вместо 403.

`batch_alter_table` нужен из-за SQLite: там `ALTER TABLE ... DROP CONSTRAINT`
отсутствует, и Alembic пересоздаёт таблицу копированием. На Postgres батч-режим
вырождается в обычный `ALTER TABLE ... DROP CONSTRAINT` + `ADD CONSTRAINT`.

`downgrade` вернёт старый перечень, поэтому после первого приглашения он упадёт
на строках с новыми ролями: удалять их молча означало бы потерять членство.
Осознанное решение — откат возможен до появления реальных приглашений.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0015_organization_roles"
down_revision: str | None = "0013_organizations_membership"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONSTRAINT_NAME = "ck_organization_members_role"

# Перечни записаны буквально, а не импортом из модели: миграция должна
# воспроизводить состояние схемы на своём шаге и не зависеть от правок модели.
OLD_ROLES = "('owner', 'admin', 'member')"
NEW_ROLES = "('owner', 'admin', 'manager', 'commandant', 'member')"


def _replace_role_check(roles: str) -> None:
    with op.batch_alter_table("organization_members") as batch_op:
        batch_op.drop_constraint(CONSTRAINT_NAME, type_="check")
        batch_op.create_check_constraint(CONSTRAINT_NAME, f"role IN {roles}")


def upgrade() -> None:
    _replace_role_check(NEW_ROLES)


def downgrade() -> None:
    _replace_role_check(OLD_ROLES)
