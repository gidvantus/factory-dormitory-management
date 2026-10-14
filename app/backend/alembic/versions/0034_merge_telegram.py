"""Объединить ветку уведомлений Telegram со сводящей ревизией develop-s.

Миграция уведомлений (`0032_telegram_notifications`) выросла от `0031_invoices`
в ветке `feature/52-telegram-notifications`. К моменту её слияния в develop-m там
уже была своя сводящая ревизия `0033_merge_develop_s`, поэтому в дереве снова
оказались две головы и `alembic upgrade head` падает с «Multiple head revisions».
Ревизии сводятся пустой миграцией — так же, как `0014_merge_activation_tables`,
`0024_merge_develop_s` и `0033_merge_develop_s`.
"""

revision = "0034_merge_telegram"
down_revision = ("0032_telegram_notifications", "0033_merge_develop_s")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
