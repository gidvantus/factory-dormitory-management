"""Объединить ветку счетов с веткой планирования заездов.

Слияние develop-s в develop-m снова соединило две цепочки миграций: наша ветка
счетов (`0031_invoices`) и ветка develop-s с планами заездов
(`0031_remove_personnel_tasks` → `0032_arrival_plans`) выросли из одного
`0030_pricing_plans`. Пока головы две, `alembic upgrade head` падает с
«Multiple head revisions», поэтому ревизии сводятся пустой миграцией — так же,
как в `0014_merge_activation_tables` и `0024_merge_develop_s`.
"""

revision = "0033_merge_develop_s"
down_revision = ("0031_invoices", "0032_arrival_plans")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
