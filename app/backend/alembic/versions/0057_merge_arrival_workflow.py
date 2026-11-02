"""Объединить ветку заездов и оформления проживания с текущей веткой develop-m.

Ветка develop-s принесла свою цепочку миграций
(`0048_offer_acceptance` → `0049_arrival_fields` → `0050_arrival_workflow`),
а develop-m за то же время выросла в `0048_offer_acceptance` →
`0049_solution_journal` → … → `0056_offer_text`. После слияния develop-s в
develop-m (#133) в дереве две головы, и `alembic upgrade head` падает с
«Multiple head revisions», из-за чего `entrypoint.sh` сервиса `api` не пускает
приложение на старте.

Ревизии сводятся пустой миграцией — как `0014_merge_activation_tables`,
`0024_merge_develop_s`, `0033_merge_develop_s`, `0034_merge_telegram`,
`0037_merge_develop_s` и `0042_merge_develop_s`: схемы она не меняет, только
сводит две головы в одну. Порядок применения от этого не страдает — обе ветки
уже содержат свои изменения, а база стенда стоит на `0056_offer_text`, поэтому
ревизия применяется одна и ничего не пересчитывает.
"""

revision = "0057_merge_arrival_workflow"
down_revision = ("0050_arrival_workflow", "0056_offer_text")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
