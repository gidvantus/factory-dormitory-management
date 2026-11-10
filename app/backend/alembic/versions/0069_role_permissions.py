"""Общие права импорта и экспорта для менеджера, администратора и коменданта."""

import sqlalchemy as sa

from alembic import op

revision: str = "0069_role_permissions"
down_revision: str | None = "0068_solutions_tariff_scope"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    table = op.create_table(
        "role_permissions",
        sa.Column("role", sa.String(30), primary_key=True),
        sa.Column("import_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("export_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.CheckConstraint(
            "role IN ('manager', 'admin', 'commandant')", name="ck_role_permissions_role"
        ),
    )
    op.bulk_insert(
        table,
        [
            {"role": role, "import_enabled": True, "export_enabled": True}
            for role in ("manager", "admin", "commandant")
        ],
    )


def downgrade() -> None:
    op.drop_table("role_permissions")
