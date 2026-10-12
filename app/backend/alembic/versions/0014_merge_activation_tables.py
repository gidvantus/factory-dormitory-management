"""Объединить миграции активации и настраиваемых таблиц без изменения данных."""

revision = "0014_merge_activation_tables"
down_revision = ("0013_recovery_wording", "0013_resident_payments")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
