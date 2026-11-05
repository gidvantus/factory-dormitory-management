"""Свести головы, разошедшиеся после слияния develop-s и develop-m в main.

`main` получил develop-s (#169) и develop-m (#170) двумя отдельными
merge-коммитами. develop-s вырос до `0062_table_views`, develop-m — до
`0060_merge_stand_heads`, и эти две головы друг о друге не знали: сводящая
ревизия нужна была в момент слияния, а не после него.

Симптом ровно тот, о котором предупреждает `0060_merge_stand_heads`: `api`
начинает старт с `alembic upgrade head` (`app/backend/entrypoint.sh`), получает
«Multiple head revisions are present for given argument 'head'», выходит, контейнер
уходит в цикл перезапуска (`restart: unless-stopped`). nginx фронта проксирует
`/api/` в `api:8000`, получает «connection refused» и отдаёт 502 — именно так
основной домен ответил 502 на `/api/health`, хотя шаг запуска стека был зелёным:
у `api` нет healthcheck'а, поэтому `docker compose up --wait` его падение не
видит.

Ревизия пустая — только сводит головы, как `0058_merge_alembic_heads` и
`0060_merge_stand_heads` до неё. Схемы и данных не касается.

Повторение этого класса сбоя теперь ловят две проверки, а не сервер:
`_tools/alembic-heads.py` (шаг деплоя до подключения к серверу и workflow
проверок pull request) и `assert_single_head` в тестах миграций.
"""

revision = "0063_merge_main_heads"
down_revision = ("0062_table_views", "0060_merge_stand_heads")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
