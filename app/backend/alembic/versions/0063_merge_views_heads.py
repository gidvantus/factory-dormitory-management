"""Свести две головы дерева ревизий — `0060_merge_stand_heads` и `0062_table_views`.

К моменту этой ревизии в `develop-m` снова оказались две головы: `0060_merge_stand_heads`
свела `0059_mail_html_bodies` и `0059_table_exchange`, а параллельно выросла ветка
`0060_merge_exchange_mail` → `0061_merge_local_notifications` → `0062_table_views` со
сведением тех же двух ревизий. На двух головах `alembic upgrade head` падает с
«Multiple head revisions», а `api` в `entrypoint.sh` начинает с этой команды и уходит
в цикл перезапусков.

Ревизия пустая — сведение веток, как `0060_merge_stand_heads` до неё: схему и данные
она не трогает. `downgrade` у сведения веток тоже ничего не делает: Alembic проводит
деградацию по выбранной ветке сам. Настоящая правка данных — следующая ревизия
`0064_mail_hero_house`, поэтому `alembic downgrade -1` с головы снимает именно её.

Идентификатор короче 32 символов: колонка `alembic_version.version_num` имеет тип
`varchar(32)`.
"""

revision = "0063_merge_views_heads"
down_revision = ("0060_merge_stand_heads", "0062_table_views")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Схема и данные не меняются: ревизия только сводит ветки."""


def downgrade() -> None:
    """Схема и данные не меняются: ветки расходятся по своим ревизиям."""
