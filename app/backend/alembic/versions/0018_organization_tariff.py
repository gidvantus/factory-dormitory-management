"""Тариф организации: колонка `organizations.tariff_id`.

Ревизия аддитивная: у организации появляется ссылка на выбранный тариф, данные
не пересеиваются. `tariff_id` nullable — у уже существующих организаций тариф
не выбран, и это нормальное состояние, а не недозаполненная строка.

Внешний ключ объявлен с `ON DELETE SET NULL`: тариф из прайса можно удалить, и
тогда организация просто остаётся без тарифа. `CASCADE` здесь был бы ошибкой —
он бы удалял организацию вместе с тарифом.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018_organization_tariff"
down_revision: str | None = "0017_tariffs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FK_NAME = "fk_organizations_tariff_id"
INDEX_NAME = "ix_organizations_tariff_id"


def upgrade() -> None:
    op.add_column("organizations", sa.Column("tariff_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        FK_NAME,
        "organizations",
        "tariffs",
        ["tariff_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(INDEX_NAME, "organizations", ["tariff_id"])


def downgrade() -> None:
    op.drop_index(INDEX_NAME, table_name="organizations")
    op.drop_constraint(FK_NAME, "organizations", type_="foreignkey")
    op.drop_column("organizations", "tariff_id")
