"""Свести две головы alembic, разошедшиеся после слияния develop-s (#159).

`0058_merge_alembic_heads` (PR #140) и `0058_merge_main_heads` — две независимо
созданные сводящие ревизии с одинаковым `down_revision`. Каждая стала головой
своей ветки, поверх них выросли `0059_mail_html_bodies` (шаблоны писем) и
`0059_table_exchange` (импорт/экспорт вкладок), поэтому в дереве снова две
головы и `alembic upgrade head` падает с «Multiple head revisions». `api`
начинает с этой команды в `entrypoint.sh` и уходит в цикл перезапуска.

Ревизия пустая — только сводит головы, как `0058_merge_alembic_heads` до неё.
Схемы и данных не касается.

Причина повторов одна и та же: сводящую ревизию добавляет каждая ветка,
которая сливает develop-s или main, и две такие ветки, слитые по очереди,
не знают друг о друге. Пока в pull request нет проверки «ровно одна голова
alembic», это будет повторяться при каждом параллельном слиянии.
"""

revision = "0060_merge_stand_heads"
down_revision = ("0059_mail_html_bodies", "0059_table_exchange")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
