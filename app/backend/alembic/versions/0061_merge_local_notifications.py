"""Связать с общей цепочкой уже применённую ревизию локального стенда."""

revision = "0061_merge_local_notifications"
down_revision = ("0060_merge_exchange_mail", "0060_personal_notifications")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
