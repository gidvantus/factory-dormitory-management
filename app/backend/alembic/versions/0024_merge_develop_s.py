"""Объединить ветку тарифов и организаций с веткой персонала и статистики.

Слияние develop-s в develop-m соединило две цепочки миграций, выросшие из
`0013_recovery_wording`: наша (организации, приглашения, тарифы) и ветка
develop-s (настраиваемые таблицы, шаблоны, статистика, персонал). Пока головы
две, `alembic upgrade head` падает с «Multiple head revisions», поэтому ревизии
сводятся пустой миграцией, как это уже сделано в `0014_merge_activation_tables`.
"""

revision = "0024_merge_develop_s"
down_revision = ("0018_organization_tariff", "0023_personnel")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
