"""Свести две головы alembic, разошедшиеся после одновременных слияний develop-s.

`0057_merge_arrival_workflow` (#133, стенд и доработка DEVELOPER) и
`0057_merge_develop_s` (#139, ветка develop-s с ячейками, конструктором
персонала и вкладками архива) созданы независимо от одной и той же базы
`0056_offer_text`, поэтому каждая стала отдельной головой, и
`alembic upgrade head` снова падает с «Multiple head revisions». `api` в
`entrypoint.sh` начинает с этой команды и уходит в цикл перезапуска.

Ревизия пустая: схемы она не меняет, только сводит две головы в одну — тот же
приём, что в `0014_merge_activation_tables`, `0024_merge_develop_s`,
`0033_merge_develop_s`, `0034_merge_telegram`, `0037_merge_develop_s`,
`0042_merge_develop_s` и `0057_merge_arrival_workflow`.

Чтобы это не повторялось, порядок слияния должен оставаться прежним: сперва
develop-s → develop-m (со своей сводящей ревизией), потом любая ветка, которая
тоже сводит головы, — иначе две сводящие ревизии снова дадут две головы.
"""

revision = "0058_merge_alembic_heads"
down_revision = ("0057_merge_arrival_workflow", "0057_merge_develop_s")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
