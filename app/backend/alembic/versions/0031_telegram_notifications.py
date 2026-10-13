"""Telegram-уведомления: привязка чата, подписки и очередь доставки.

Ревизия аддитивная: три новые таблицы, существующие данные не пересеиваются.
Все колонки либо nullable, либо с `server_default`, новых NOT NULL без default
нет — на базе с данными шаг проходит без ручной подготовки.

Отдельного хранилища кодов привязки здесь нет намеренно: код живёт в
`activation_tokens` с новым видом `telegram_link`. Свойства у него те же, что у
ссылки активации — в базе только SHA-256 открытого кода, свой срок жизни и
одноразовость через `used_at`, — поэтому новая таблица дублировала бы уже
существующую. Из-за этого же здесь расширяется `CHECK` по `kind`: без него
вставка кода привязки упала бы на ограничении.

Номер ревизии взят по фактической голове: план issue просил
`0030_telegram_notifications` от `0029_tariff_half_year`, но к моменту работы
над задачей на месте `0030` уже стояла `0030_pricing_plans` (issue #34). Две
головы от `0029` сломали бы `alembic upgrade head`, поэтому ревизия сдвинута на
`0031` и идёт следом за прайсом.

Откат удаляет привязки, подписки и историю доставок — данные пользователей он
не затрагивает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.models.activation import ACTIVATION_TOKEN_KINDS

revision: str = "0031_telegram_notifications"
down_revision: str | None = "0030_pricing_plans"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Перечень видов доставки для `CHECK`: тот же, что у модели `NotificationDelivery`.
DELIVERY_STATUSES = ("pending", "sent", "failed")
DELIVERY_STATUSES_SQL = ", ".join(f"'{status}'" for status in DELIVERY_STATUSES)

# Виды одноразовых ссылок с добавленным кодом привязки Telegram: перечень
# собирается из константы модели, чтобы ограничение и модель не разошлись.
ACTIVATION_KINDS_SQL = ", ".join(f"'{kind}'" for kind in ACTIVATION_TOKEN_KINDS)


def upgrade() -> None:
    op.create_table(
        "telegram_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("chat_id", sa.String(length=32), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "notification_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column(
            "is_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("user_id", "kind", name="uq_notification_subscriptions_user_kind"),
    )

    op.create_table(
        "notification_deliveries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("chat_id", sa.String(length=32), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("event_key", sa.String(length=80), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.String(length=255), nullable=True),
        sa.UniqueConstraint("user_id", "event_key", name="uq_notification_deliveries_user_event"),
        sa.CheckConstraint(
            f"status IN ({DELIVERY_STATUSES_SQL})",
            name="ck_notification_deliveries_status",
        ),
    )

    # Новый вид одноразовой ссылки: код привязки чата. Ограничение пересобирается
    # целиком — Postgres не умеет расширять CHECK на месте.
    op.drop_constraint("ck_activation_tokens_kind", "activation_tokens", type_="check")
    op.create_check_constraint(
        "ck_activation_tokens_kind",
        "activation_tokens",
        f"kind IN ({ACTIVATION_KINDS_SQL})",
    )


def downgrade() -> None:
    # Порядок обратный: сначала снимаем вид ссылки, потом таблицы. Коды привязки
    # удаляются вместе с ограничением — иначе устаревшая строка осталась бы в
    # таблице и следующий `upgrade` упал бы на восстановлении CHECK.
    op.execute("DELETE FROM activation_tokens WHERE kind = 'telegram_link'")
    op.drop_constraint("ck_activation_tokens_kind", "activation_tokens", type_="check")
    op.create_check_constraint(
        "ck_activation_tokens_kind",
        "activation_tokens",
        "kind IN ('activation', 'recovery', 'invitation')",
    )

    op.drop_table("notification_deliveries")
    op.drop_table("notification_subscriptions")
    op.drop_table("telegram_links")
