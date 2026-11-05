"""Объединить миграции обмена Excel и HTML-шаблонов писем."""

revision = "0060_merge_exchange_mail"
down_revision = ("0059_table_exchange", "0059_mail_html_bodies")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
