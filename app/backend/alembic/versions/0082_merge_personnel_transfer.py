"""Свести головы alembic: 0080_personnel_sort_name, 0081_merge_metrika_transfer.

Ревизия создана `python _tools/alembic-heads.py --merge`: в дереве было
2 головы, а `alembic upgrade head` работает только с одной. Головы
расходятся, когда develop-s и develop-m (или две ветки задач) независимо
добавляют ревизии, а слияние не сводит их между собой.

Ревизия пустая — только сводит головы, схемы и данных не касается. Допишите
причину, если она не сводится к параллельному слиянию веток.
"""

revision = "0082_merge_personnel_transfer"
down_revision = ("0080_personnel_sort_name", "0081_merge_metrika_transfer")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
