"""Добавить в организации КПП, ОГРН и адрес регистрации.

Реквизиты приходят из DaData по ИНН и хранятся рядом с названием: без них
карточка организации неполная. Все три колонки nullable — у только что
созданной организации и у организации, которую ещё не искали, реквизитов нет.
Отдельно у индивидуального предпринимателя КПП не бывает вовсе, поэтому
`NULL` в `kpp` — это нормальное состояние, а не незаполненное поле.

Ревизия идёт после `0025_documents`, а не после `0024_merge_develop_s`:
на develop-m уже есть голова от публичных документов, и вторая ветка от 0024
дала бы две головы — `alembic upgrade head` падал бы с «Multiple head
revisions».
"""

import sqlalchemy as sa

from alembic import op

revision = "0026_organization_requisites"
down_revision = "0025_documents"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("organizations", sa.Column("kpp", sa.String(length=9), nullable=True))
    op.add_column("organizations", sa.Column("ogrn", sa.String(length=15), nullable=True))
    op.add_column("organizations", sa.Column("address", sa.String(length=500), nullable=True))


def downgrade() -> None:
    op.drop_column("organizations", "address")
    op.drop_column("organizations", "ogrn")
    op.drop_column("organizations", "kpp")
