"""Добавить обязательные формульные строки в существующие общежития."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_required_report_rows"
down_revision: str | None = "0004_report_templates"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRED_NAMES = ("Выход Итого", "Проживает Итого", "Текучка Итого")


def upgrade() -> None:
    connection = op.get_bind()
    dormitory_ids = list(connection.execute(sa.text("SELECT id FROM dormitories ORDER BY id")).scalars())
    for dormitory_id in dormitory_ids:
        rows = connection.execute(
            sa.text(
                "SELECT id, name, formula, position FROM report_rows "
                "WHERE dormitory_id = :dormitory_id ORDER BY position, id"
            ),
            {"dormitory_id": dormitory_id},
        ).all()
        position = max((row.position for row in rows), default=0)
        for name in REQUIRED_NAMES:
            matches = [row for row in rows if row.name.casefold() == name.casefold()]
            if matches:
                row = matches[0]
                if len(matches) > 1 or row.name != name:
                    raise RuntimeError(
                        f"Строка «{name}» в общежитии {dormitory_id} требует ручной проверки"
                    )
                if row.formula is None:
                    cell_count = connection.execute(
                        sa.text("SELECT count(*) FROM report_cells WHERE row_id = :row_id"),
                        {"row_id": row.id},
                    ).scalar_one()
                    if cell_count:
                        raise RuntimeError(
                            f"Строка «{name}» в общежитии {dormitory_id} содержит данные"
                        )
                    connection.execute(
                        sa.text("UPDATE report_rows SET formula = '=0' WHERE id = :row_id"),
                        {"row_id": row.id},
                    )
                continue
            position += 1
            connection.execute(
                sa.text(
                    "INSERT INTO report_rows (dormitory_id, name, position, formula) "
                    "VALUES (:dormitory_id, :name, :position, '=0')"
                ),
                {"dormitory_id": dormitory_id, "name": name, "position": position},
            )


def downgrade() -> None:
    # Пользователь мог уже настроить формулы; откат версии не должен удалять его строки.
    pass
