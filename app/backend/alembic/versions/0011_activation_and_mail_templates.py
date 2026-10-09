"""Активация кабинета по письму: токены активации и шаблоны писем.

Ревизия только добавляет таблицы: существующая `users` не меняется, уже
зарегистрированные аккаунты остаются активными, `downgrade` удаляет лишь
созданное здесь и не теряет данные пользователей.

Идентификатор ревизии короче имени файла: колонка `alembic_version.version_num`
имеет тип `varchar(32)`, и полное имя в неё не влезает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011_activation_mail_templates"
down_revision: str | None = "0010_payment_entries"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Сиид единственного шаблона: код `activation` читает `app.mail`.
# Ссылка абсолютная и подставляется на месте `{activation_url}`.
ACTIVATION_TEMPLATE_SUBJECT = "Активация личного кабинета Домовой"
ACTIVATION_TEMPLATE_BODY = (
    "Здравствуйте, {full_name}!\n"
    "\n"
    "Вы зарегистрировались в системе учёта проживающих «Домовой».\n"
    "Чтобы активировать личный кабинет, откройте ссылку:\n"
    "\n"
    "{activation_url}\n"
    "\n"
    "Ссылка действует {expires_hours} ч. и срабатывает один раз.\n"
    "Если вы не регистрировались, просто проигнорируйте это письмо.\n"
)


def upgrade() -> None:
    op.create_table(
        "activation_tokens",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_activation_tokens_user_id", "activation_tokens", ["user_id"])

    op.create_table(
        "mail_templates",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("code", sa.String(length=50), nullable=False, unique=True),
        sa.Column("subject", sa.String(length=255), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

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
                "code": "activation",
                "subject": ACTIVATION_TEMPLATE_SUBJECT,
                "body": ACTIVATION_TEMPLATE_BODY,
                "is_active": True,
            }
        ],
    )


def downgrade() -> None:
    op.drop_table("mail_templates")
    op.drop_index("ix_activation_tokens_user_id", table_name="activation_tokens")
    op.drop_table("activation_tokens")
