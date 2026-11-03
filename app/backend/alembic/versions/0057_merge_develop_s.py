"""Объединить архив общежитий и обновления удалённой ветки develop-s.

Сохраняет обе цепочки миграций и единственную конечную ревизию для upgrade head.
Само объединение не меняет схему и данные.
"""

revision = "0057_merge_develop_s"
down_revision = ("0053_archive_tabs", "0056_offer_text")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
