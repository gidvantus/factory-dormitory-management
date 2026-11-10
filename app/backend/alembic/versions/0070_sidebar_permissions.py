"""Права должностей на разделы кабинета; прежний доступ сохраняется."""

import sqlalchemy as sa

from alembic import op

revision = "0070_sidebar_permissions"
down_revision = "0069_role_permissions"
branch_labels = None
depends_on = None

FIELDS = (
    "overview_enabled",
    "dormitories_enabled",
    "personnel_enabled",
    "statistics_enabled",
    "documents_enabled",
    "shop_enabled",
    "organization_enabled",
    "members_enabled",
    "profile_enabled",
)


def upgrade() -> None:
    for field in FIELDS:
        op.add_column(
            "role_permissions",
            sa.Column(field, sa.Boolean(), nullable=False, server_default=sa.true()),
        )


def downgrade() -> None:
    for field in reversed(FIELDS):
        op.drop_column("role_permissions", field)
