"""Свести головы: `0060_merge_stand_heads` и основную ветку `0062_table_views`.

`develop-m` пришёл в состояние двух голов: ветка стенда оставила в дереве
`0060_merge_stand_heads` — слияние `0059_mail_html_bodies` и `0059_table_exchange`,
никем не продолженное, — а основная ветка ушла от того же слияния вперёд
(`0060_merge_exchange_mail` → `0061_merge_local_notifications` →
`0062_table_views`). Alembic считает головой любую ревизию, на которую никто не
ссылается, поэтому `alembic upgrade head` падал с `Multiple head revisions are
present for given argument 'head'` — то есть стенд не поднимался, а
`tests/test_*_migration.py`, проверяющие одну голову, падали на `develop-m` ещё до
этой задачи.

Эта ревизия ничего не меняет в схеме: она только сводит две головы в одну и
повторяет приём `0058_merge_alembic_heads` и `0060_merge_stand_heads`. Ветка
стенда пустая (её `upgrade` и `downgrade` — `pass`), поэтому слияние не несёт ни
DDL, ни данных.

**Слияние стоит до ревизии задачи, а не после неё.** Так голова дерева остаётся
обычной ревизией с одним родителем (`0064_extra_seats`), и `alembic downgrade -1`
на стенде работает: у слияния два родителя, и относительный откат от него самого
alembic выполнить не может — отвечает `Ambiguous walk`. Проверка «`upgrade head` →
`downgrade -1` → `upgrade head`» поэтому проходит только в таком порядке
ревизий; проверять откат слияния отдельно нужно командой с явной целью
(`alembic downgrade 0062_table_views`), и тогда дерево снова видит две головы —
это и есть состояние `develop-m` до этой ветки, а не поломка.

Идентификатор короче 32 символов: колонка `alembic_version.version_num` имеет тип
`varchar(32)`.
"""

from collections.abc import Sequence

revision: str = "0063_merge_stand_heads"
down_revision: tuple[str, str] = ("0060_merge_stand_heads", "0062_table_views")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
