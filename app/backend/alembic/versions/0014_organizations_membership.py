"""Организации и членство: владелец у каждого существующего пользователя.

Ревизия создаёт `organizations` и `organization_members`, добавляет
`users.active_organization_id` и заводит каждому уже существующему пользователю
пустую организацию с ролью `owner`.

Номер файла — `0014`, а не `0013`, как было в плане issue: ревизия `0013` уже
занята формулировкой письма восстановления (`0013_recovery_letter_wording`),
которая попала в `develop-m` раньше. Идентификатор ревизии при этом остаётся
`0013_organizations_membership`: важно, что он короче 32 символов и влезает в
`alembic_version.version_num`, а не то, что он совпадает с номером файла.
Цепочка — строго после `0013_recovery_wording`: две ревизии с одним
`down_revision` дали бы ветвление и второй head.

Бэкфилл идемпотентен: он трогает только пользователей без
`active_organization_id`, поэтому повторный `upgrade` (или `upgrade` поверх
базы, где организации уже есть) не создаёт вторых организаций.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013_organizations_membership"
down_revision: str | None = "0013_recovery_wording"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Владелец — единственная роль, которую выдаёт эта задача.
OWNER_ROLE = "owner"

ACTIVE_ORGANIZATION_INDEX = "ix_users_active_organization_id"
ACTIVE_ORGANIZATION_FK = "fk_users_active_organization_id"


def upgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("name", sa.String(length=255), nullable=True),
        sa.Column("inn", sa.String(length=12), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # Несколько NULL друг другу не мешают: пустая заготовка — норма,
        # а занятый ИНН должен принадлежать ровно одной организации.
        sa.UniqueConstraint("inn", name="uq_organizations_inn"),
    )
    op.create_table(
        "organization_members",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column(
            "organization_id",
            sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(length=30), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("organization_id", "user_id", name="uq_organization_members_org_user"),
        sa.CheckConstraint(
            "role IN ('owner', 'admin', 'member')",
            name="ck_organization_members_role",
        ),
    )
    op.create_index("ix_organization_members_user_id", "organization_members", ["user_id"])
    op.create_index(
        "ix_organization_members_organization_id", "organization_members", ["organization_id"]
    )

    # Колонка появляется только после `organizations`: иначе FK не на что ссылаться.
    op.add_column("users", sa.Column("active_organization_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        ACTIVE_ORGANIZATION_FK,
        "users",
        "organizations",
        ["active_organization_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(ACTIVE_ORGANIZATION_INDEX, "users", ["active_organization_id"])

    _backfill_organizations()


def _backfill_organizations() -> None:
    """Завести организацию и владельца каждому пользователю без организации.

    Организации вставляются по одной, чтобы получить их `id`: сначала нужны
    идентификаторы, потом — строки членства с этими идентификаторами. Массовая
    вставка членства отдаёт `id` организаций в том же порядке, что и `user_ids`,
    поэтому пары «организация — пользователь» не перепутаются.

    Название и ИНН остаются `NULL`: у бэкфилл-организаций та же пустая заготовка,
    что и у новых пользователей, поэтому данные пользователей не искажаются.
    """
    bind = op.get_bind()
    user_ids = list(
        bind.execute(
            sa.text("SELECT id FROM users WHERE active_organization_id IS NULL ORDER BY id")
        ).scalars()
    )
    if not user_ids:
        return

    organization_ids = [
        bind.execute(
            sa.text("INSERT INTO organizations (name, inn) VALUES (NULL, NULL) RETURNING id")
        ).scalar_one()
        for _ in user_ids
    ]
    rows = [
        {"organization_id": organization_id, "user_id": user_id, "role": OWNER_ROLE}
        for organization_id, user_id in zip(organization_ids, user_ids, strict=True)
    ]
    bind.execute(
        sa.text(
            "INSERT INTO organization_members (organization_id, user_id, role) "
            "VALUES (:organization_id, :user_id, :role)"
        ),
        rows,
    )
    bind.execute(
        sa.text("UPDATE users SET active_organization_id = :organization_id WHERE id = :user_id"),
        rows,
    )


def downgrade() -> None:
    # Обратный порядок: сначала колонка, потом то, на что она ссылалась.
    op.drop_index(ACTIVE_ORGANIZATION_INDEX, table_name="users")
    op.drop_constraint(ACTIVE_ORGANIZATION_FK, "users", type_="foreignkey")
    op.drop_column("users", "active_organization_id")

    op.drop_index("ix_organization_members_organization_id", table_name="organization_members")
    op.drop_index("ix_organization_members_user_id", table_name="organization_members")
    op.drop_table("organization_members")
    op.drop_table("organizations")
