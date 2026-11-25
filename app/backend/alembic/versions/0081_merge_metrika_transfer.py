"""Свести ветки миграций: тексты метрики и сопоставление столбцов.

`0079_metrika_consent_texts` и `0080_transfer_column_mappings` выросли из общего
предка `0078_hostel_resident_filters` и меняют разные таблицы. Пока ветки не
сведены, `alembic upgrade head` останавливается на двух головах. Эта ревизия —
только слияние: `upgrade()` и `downgrade()` ничего не меняют, схему уже
подготовили обе ветки.
"""

revision = "0081_merge_metrika_transfer"
down_revision = ("0079_metrika_consent_texts", "0080_transfer_column_mappings")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
