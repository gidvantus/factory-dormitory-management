"""Тарифы публичного прайса.

Ревизия только добавляет таблицу: существующие данные не меняются, `downgrade`
удаляет `tariffs` целиком. Данные не сидим — список наполняется из кабинета, и
откат до первого настоящего тарифа ничего не теряет. После наполнения откат
стирает введённый прайс, поэтому делать его нужно осознанно.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017_tariffs"
down_revision: str | None = "0016_invitation_kind"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tariffs",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("amount", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default="RUB"),
        sa.Column("period", sa.String(length=10), nullable=False, server_default="month"),
        sa.Column("unit_label", sa.String(length=40), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_visible", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint("amount >= 0", name="ck_tariffs_amount_non_negative"),
        sa.CheckConstraint("period IN ('month', 'year', 'once')", name="ck_tariffs_period"),
    )


def downgrade() -> None:
    op.drop_table("tariffs")
