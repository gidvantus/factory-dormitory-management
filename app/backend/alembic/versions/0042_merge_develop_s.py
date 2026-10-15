"""Объединить ветку согласия и журнала с веткой выбытия, притока и вкладок.

Наша ветка (`0038_audit_changes_column` → `0039_consent`) и ветка develop-s
(`0038_outflow_eviction` → `0039_inflow_resident_values` →
`0040_custom_tab_options` → `0041_remove_shift_decisions`) выросли из одной
точки `0037_merge_develop_s`, поэтому после слияния в дереве снова две головы и
`alembic upgrade head` падает с «Multiple head revisions». Ревизии сводятся
пустой миграцией — как `0014_merge_activation_tables`, `0024_merge_develop_s`,
`0033_merge_develop_s`, `0034_merge_telegram` и `0037_merge_develop_s`.
"""

revision = "0042_merge_develop_s"
down_revision = ("0039_consent", "0041_remove_shift_decisions")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
