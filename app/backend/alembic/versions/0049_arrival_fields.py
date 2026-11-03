"""Общие настройки заездов организации и значения полей.

Существующие количества, ФИО и ревизии не переписываются. При чтении старых
записей отдельные строки людей строятся из names со стабильными ID.
"""

from alembic import op
import sqlalchemy as sa

revision = "0049_arrival_fields"
down_revision = "0048_offer_acceptance"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("arrival_plans", sa.Column("people", sa.JSON(), nullable=True))
    op.add_column("arrival_plans", sa.Column("custom_values", sa.JSON(), nullable=False, server_default="{}"))
    op.create_table(
        "arrival_settings",
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("settings", sa.JSON(), nullable=False),
        sa.Column("retired_fields", sa.JSON(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("arrival_settings")
    op.drop_column("arrival_plans", "custom_values")
    op.drop_column("arrival_plans", "people")
