"""Счета организации и их печатные формы.

Ревизия аддитивная: появляются две новые таблицы, существующие данные не
трогаются. `invoices` хранит снимок покупателя и предмета на момент покупки,
поэтому правка карточки организации или удаление тарифа из прайса уже
выставленный счёт не меняет.

Ссылки: `organization_id` — `CASCADE` (со счётом организации уходят и её счета),
`tariff_id` — `SET NULL` (удаление тарифа из прайса счёт не ломает: название и
период остались в снимке). Уникальность пары `(invoice_id, kind)` не даёт
завести по одному счёту второй акт.

Голова Alembic на момент ревизии — `0030_pricing_plans`: полугодовой период и
стартовый прайс уже влиты в `develop-m` (issue #34), поэтому ревизия встаёт
поверх них, а не поверх `0028_trial_period`. Если параллельно появится вторая
голова, при вливании понадобится merge-ревизия — как `0024_merge_develop_s`.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031_invoices"
down_revision: str | None = "0030_pricing_plans"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Значения записаны прямо в SQL, а не взяты из `app.models.invoice`: миграция
# должна читаться и исполняться без импорта приложения, иначе правка модели
# задним числом меняет смысл уже выпущенной ревизии.
STATUSES_SQL = "'new', 'paid', 'closed', 'cancelled'"
DOCUMENT_KINDS_SQL = "'act'"

INVOICES_INDEX = "ix_invoices_organization_id"
DOCUMENTS_INDEX = "ix_invoice_documents_invoice_id"


def upgrade() -> None:
    op.create_table(
        "invoices",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("tariff_id", sa.Integer(), nullable=True),
        sa.Column("number", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="new"),
        sa.Column("amount", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default="RUB"),
        sa.Column("buyer_name", sa.String(length=255), nullable=True),
        sa.Column("buyer_inn", sa.String(length=12), nullable=True),
        sa.Column("buyer_kpp", sa.String(length=9), nullable=True),
        sa.Column("buyer_ogrn", sa.String(length=15), nullable=True),
        sa.Column("buyer_address", sa.String(length=500), nullable=True),
        sa.Column("tariff_name", sa.String(length=120), nullable=True),
        sa.Column("tariff_period", sa.String(length=10), nullable=True),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name="fk_invoices_organization_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tariff_id"],
            ["tariffs.id"],
            name="fk_invoices_tariff_id",
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint("number", name="uq_invoices_number"),
        sa.CheckConstraint(f"status IN ({STATUSES_SQL})", name="ck_invoices_status"),
    )
    op.create_index(INVOICES_INDEX, "invoices", ["organization_id"])

    op.create_table(
        "invoice_documents",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("invoice_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["invoice_id"],
            ["invoices.id"],
            name="fk_invoice_documents_invoice_id",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("invoice_id", "kind", name="uq_invoice_documents_invoice_kind"),
        sa.CheckConstraint(f"kind IN ({DOCUMENT_KINDS_SQL})", name="ck_invoice_documents_kind"),
    )
    op.create_index(DOCUMENTS_INDEX, "invoice_documents", ["invoice_id"])


def downgrade() -> None:
    op.drop_index(DOCUMENTS_INDEX, table_name="invoice_documents")
    op.drop_table("invoice_documents")
    op.drop_index(INVOICES_INDEX, table_name="invoices")
    op.drop_table("invoices")
