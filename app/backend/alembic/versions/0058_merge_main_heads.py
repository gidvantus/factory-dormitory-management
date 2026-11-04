"""Объединить миграции main и develop-s после слияния веток.

Обе ветки уже содержат объединяющие ревизии 0057. Эта ревизия оставляет
единственную голову для upgrade head, сохраняя обе цепочки без изменения данных.
"""

revision = "0058_merge_main_heads"
down_revision = ("0057_merge_arrival_workflow", "0057_merge_develop_s")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
