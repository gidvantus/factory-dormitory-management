"""Восстановление пароля: вид токена, счётчик запросов и шаблон письма.

Ревизия добавляет колонку `kind` с `server_default`, новую таблицу
`recovery_requests` и строку шаблона `password_recovery`. Существующие токены
активации остаются валидными и получают `kind = "activation"`; данные
пользователей не меняются, поэтому `downgrade` безопасен.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012_password_recovery"
down_revision: str | None = "0011_activation_mail_templates"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Сиид второго шаблона: код `password_recovery` читает `app.mail`.
# Подстановки те же, что у письма активации, — экран смены пароля общий.
RECOVERY_TEMPLATE_CODE = "password_recovery"
RECOVERY_TEMPLATE_SUBJECT = "Восстановление пароля в системе «Домовой»"
RECOVERY_TEMPLATE_BODY = (
    "Здравствуйте, {full_name}!\n"
    "\n"
    "Вы запросили восстановление пароля в системе учёта проживающих «Домовой».\n"
    "Чтобы задать новый пароль, откройте ссылку:\n"
    "\n"
    "{activation_url}\n"
    "\n"
    "Ссылка действует {expires_hours} ч. и срабатывает один раз.\n"
    "Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.\n"
)


def upgrade() -> None:
    op.add_column(
        "activation_tokens",
        sa.Column(
            "kind",
            sa.String(length=30),
            nullable=False,
            server_default="activation",
        ),
    )
    op.create_check_constraint(
        "ck_activation_tokens_kind",
        "activation_tokens",
        "kind IN ('activation', 'recovery')",
    )

    op.create_table(
        "recovery_requests",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("identifier_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_recovery_requests_identifier_hash",
        "recovery_requests",
        ["identifier_hash"],
    )
    op.create_index("ix_recovery_requests_created_at", "recovery_requests", ["created_at"])

    op.bulk_insert(
        sa.table(
            "mail_templates",
            sa.column("code", sa.String(length=50)),
            sa.column("subject", sa.String(length=255)),
            sa.column("body", sa.Text()),
            sa.column("is_active", sa.Boolean()),
        ),
        [
            {
                "code": RECOVERY_TEMPLATE_CODE,
                "subject": RECOVERY_TEMPLATE_SUBJECT,
                "body": RECOVERY_TEMPLATE_BODY,
                "is_active": True,
            }
        ],
    )


def downgrade() -> None:
    # Шаблон удаляем только свой: строка `activation` остаётся на месте.
    op.execute(
        sa.text("DELETE FROM mail_templates WHERE code = :code").bindparams(
            code=RECOVERY_TEMPLATE_CODE
        )
    )

    op.drop_index("ix_recovery_requests_created_at", table_name="recovery_requests")
    op.drop_index("ix_recovery_requests_identifier_hash", table_name="recovery_requests")
    op.drop_table("recovery_requests")

    op.drop_constraint("ck_activation_tokens_kind", "activation_tokens", type_="check")
    op.drop_column("activation_tokens", "kind")
