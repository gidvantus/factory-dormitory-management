"""Ключ порядка страницы персонала: `employees.sort_name` и индекс `(sort_name, id)`.

Страница людей (#251) сортируется по ФИО, а не по `id`: порядок задаёт
нормализованное ФИО (регистр, «ё» и повторные пробелы не различаются) — та же
форма, которой пользуется клиентский `personName`. Считать её выражением в
каждом запросе значило бы сортировать весь список на каждый вызов и потерять
индекс, поэтому значение живёт колонкой и обновляется при записи ФИО
(`Employee._keep_sort_name` в `app/models/personnel.py`).

Индекс повторяет порядок страницы — `ORDER BY sort_name, id`, поэтому `LIMIT`
по странице не требует отдельной сортировки.

**Откуда берётся значение старых строк.** `full_name` карточки может быть пустым,
а показываемое имя приходить из присоединённой карточки: карточки сливаются
через `merged_into_id`, и `group_identities` берёт первое непустое ФИО по группе.
Поэтому `upgrade()` раскладывает группы слияний и для корней без своего ФИО
берёт имя участника — иначе такие люди уехали бы в начало списка пустой строкой,
а не встали на своё место по алфавиту.

**Откат** удаляет индекс и колонку: они не участвуют ни в одном внешнем ключе,
и прежняя схема после `downgrade()` восстанавливается полностью.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0080_personnel_sort_name"
down_revision: str | None = "0079_metrika_consent_texts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX_NAME = "ix_employees_sort_name"

EMPLOYEES = sa.table(
    "employees",
    sa.column("id", sa.String),
    sa.column("full_name", sa.String),
    sa.column("merged_into_id", sa.String),
    sa.column("sort_name", sa.String),
)


def normalized_name(value: str | None) -> str:
    """Копия `app.models.personnel.normalized_name`: миграция не зависит от кода."""
    return " ".join((value or "").lower().replace("ё", "е").split())


def upgrade() -> None:
    """Колонка, индекс и значения для уже существующих карточек."""
    op.add_column(
        "employees",
        sa.Column("sort_name", sa.String(length=255), nullable=False, server_default=""),
    )
    op.create_index(INDEX_NAME, "employees", ["sort_name", "id"])

    connection = op.get_bind()
    rows = list(
        connection.execute(
            sa.select(EMPLOYEES.c.id, EMPLOYEES.c.full_name, EMPLOYEES.c.merged_into_id)
        )
    )
    names = {row.id: normalized_name(row.full_name) for row in rows}
    links = {row.id: row.merged_into_id for row in rows}

    def root_of(employee_id: str) -> str:
        """Корень группы слияний — как `root_map` в приложении."""
        root = employee_id
        seen: set[str] = set()
        while links.get(root) and root not in seen:
            seen.add(root)
            target = links[root] or ""
            if target not in links:
                break
            root = target
        return root

    # Первое непустое имя группы — то же правило, что у `group_identities`:
    # сначала своё ФИО корня, и только потом ФИО участников.
    identity: dict[str, str] = {}
    for employee_id in sorted(names):
        root = root_of(employee_id)
        if root == employee_id and names[employee_id]:
            identity[root] = names[employee_id]
    for employee_id in sorted(names):
        root = root_of(employee_id)
        if not identity.get(root) and names[employee_id]:
            identity[root] = names[employee_id]
    for employee_id in sorted(names):
        value = names[employee_id] or identity.get(employee_id, "")
        if value:
            connection.execute(
                EMPLOYEES.update().where(EMPLOYEES.c.id == employee_id).values(sort_name=value)
            )


def downgrade() -> None:
    """Прежняя схема: колонка и индекс удаляются."""
    op.drop_index(INDEX_NAME, table_name="employees")
    op.drop_column("employees", "sort_name")
