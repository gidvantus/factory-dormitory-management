"""Журнал импортов таблиц: новая таблица, существующие данные не меняются.

`down_revision` — `0026_organization_requisites`, голова `develop-m`. Постановка
задачи называет `0025_import_jobs` от `0024_merge_develop_s`, но это уже было бы
неверно дважды: ревизия `0025_documents` (задача #33) и `0026_organization_requisites`
(задача #37) пришли на ветку раньше, и ветка от `0024` дала бы вторую голову —
`alembic upgrade head` падал бы с «Multiple head revisions».
"""

import sqlalchemy as sa
from alembic import op

revision = "0027_import_jobs"
down_revision = "0026_organization_requisites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "import_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "dormitory_id",
            sa.Integer(),
            sa.ForeignKey("dormitories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("table_key", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column(
            "created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result", sa.JSON(), nullable=False),
    )
    op.create_index("ix_import_jobs_dormitory_id", "import_jobs", ["dormitory_id"])


def downgrade() -> None:
    op.drop_index("ix_import_jobs_dormitory_id", table_name="import_jobs")
    op.drop_table("import_jobs")
