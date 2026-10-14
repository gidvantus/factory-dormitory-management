"""Объединить ветку журнала действий с веткой персонала, отчётов и прайса.

Наша ветка журнала (`0036_audit_events`) и ветка develop-s с действиями по
притоку, причинами выбытия и упрощением фильтров персонала
(`0034_simplify_personnel_filters` → `0035_outflow_reasons` →
`0036_inflow_actions`) выросли из одной точки, поэтому после слияния в дереве
снова две головы и `alembic upgrade head` падает с «Multiple head revisions».
Ревизии сводятся пустой миграцией — как `0014_merge_activation_tables`,
`0024_merge_develop_s`, `0033_merge_develop_s` и `0034_merge_telegram`.
"""

revision = "0037_merge_develop_s"
down_revision = ("0036_audit_events", "0036_inflow_actions")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
