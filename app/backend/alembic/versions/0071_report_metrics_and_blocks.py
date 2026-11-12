"""Постоянные связи итогов отчёта и настройки встроенных блоков."""

import sqlalchemy as sa

from alembic import op

revision = "0071_report_metrics_and_blocks"
down_revision = "0070_sidebar_permissions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    metrics = {
        "выход итого": "attendance",
        "проживает итого": "residents",
        "текучка итого": "turnover",
    }
    for table_name in ("report_rows", "report_template_rows"):
        op.add_column(table_name, sa.Column("metric_key", sa.String(20), nullable=True))
        table = sa.table(table_name, sa.column("id"), sa.column("name"), sa.column("metric_key"))
        rows = connection.execute(sa.select(table.c.id, table.c.name)).all()
        for row_id, name in rows:
            if metric := metrics.get(name.casefold()):
                connection.execute(
                    table.update().where(table.c.id == row_id).values(metric_key=metric)
                )
    op.create_index(
        "uq_report_rows_dorm_metric", "report_rows", ["dormitory_id", "metric_key"], unique=True
    )
    op.add_column(
        "dashboard_layout",
        sa.Column("builtin_settings", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("dashboard_layout", "builtin_settings")
    op.drop_index("uq_report_rows_dorm_metric", table_name="report_rows")
    op.drop_column("report_template_rows", "metric_key")
    op.drop_column("report_rows", "metric_key")
