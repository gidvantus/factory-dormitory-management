"""Telegram: привязка чата, подписки и очередь доставки.

Состояние живёт целиком в CRM: бот — тонкий воркер, который ходит в Bot API и
забирает из этих таблиц готовые сообщения. Публичного вебхука нет.

`chat_id` и `username` — персональные данные: они не попадают в логи, а при
отвязке строка не удаляется физически, а получает `revoked_at`. Так история
доставок остаётся целой, а сообщения человеку больше не уходят.
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# Вид события «выселение проживающего»: единственный в каталоге этой задачи.
# Каталог расширяется одной строкой константы, а проверка `kind` — по коду.
RESIDENT_OUTFLOW_KIND = "resident_outflow"

# Служебный вид тестового сообщения: подписки у него нет, оно всегда адресное.
# Отдельный код нужен, чтобы тестовая доставка не путалась с настоящим событием.
TELEGRAM_TEST_KIND = "telegram_test"

# Виды событий, о которых можно подписаться. Заголовки — для кабинета.
NOTIFICATION_KINDS = (RESIDENT_OUTFLOW_KIND,)
NOTIFICATION_KIND_TITLES = {
    RESIDENT_OUTFLOW_KIND: "Выселение проживающего",
}

# Состояния доставки. Перечень для `CHECK` собирается из константы, чтобы модель
# и миграция не разошлись.
DELIVERY_PENDING = "pending"
DELIVERY_SENT = "sent"
DELIVERY_FAILED = "failed"
DELIVERY_STATUSES = (DELIVERY_PENDING, DELIVERY_SENT, DELIVERY_FAILED)
DELIVERY_STATUSES_SQL = ", ".join(f"'{status}'" for status in DELIVERY_STATUSES)


def kind_title(kind: str) -> str:
    """Заголовок вида события для кабинета. Незнакомый код отдаётся как есть."""
    return NOTIFICATION_KIND_TITLES.get(kind, kind)


class TelegramLink(Base):
    """Привязка чата Telegram к учётной записи.

    У пользователя не больше одной живой привязки — это держит `unique` по
    `user_id`. Повторная привязка не заводит вторую строку, а оживляет прежнюю:
    `revoked_at` снова становится `NULL`, а `chat_id` заменяется.
    """

    __tablename__ = "telegram_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    # Идентификатор чата в Telegram. Строкой, а не числом: у групп он
    # отрицательный, а колонка одинакова для личных чатов и групп.
    chat_id: Mapped[str] = mapped_column(String(32), nullable=False)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Момент отвязки. `NULL` — привязка живая.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class NotificationSubscription(Base):
    """Подписка пользователя на вид события.

    Строки может не быть вовсе: это значит «подписка по умолчанию», а по
    умолчанию новый кабинет подписан на выселение. Тогда отписка — это строка с
    `is_enabled = false`, а не отсутствие строки.
    """

    __tablename__ = "notification_subscriptions"
    __table_args__ = (
        UniqueConstraint("user_id", "kind", name="uq_notification_subscriptions_user_kind"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class NotificationDelivery(Base):
    """Готовое к отправке сообщение.

    `event_key` — ключ идемпотентности: одно и то же событие не создаёт второй
    доставки одному и тому же человеку. Уникальность держит база, а не код
    вызывающего: повторный вызов хука не должен дублировать сообщение.

    `status` ведёт бот: `pending` — ждёт отправки, `sent` — ушло, `failed` —
    Bot API отказал. Пометка `sent` идёт в одной транзакции с выдачей `feed`.
    """

    __tablename__ = "notification_deliveries"
    __table_args__ = (
        UniqueConstraint("user_id", "event_key", name="uq_notification_deliveries_user_event"),
        CheckConstraint(
            f"status IN ({DELIVERY_STATUSES_SQL})", name="ck_notification_deliveries_status"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Адрес доставки на момент постановки в очередь: если человек отвяжет чат,
    # уже поставленное сообщение всё равно должно уйти на прежний адрес.
    chat_id: Mapped[str] = mapped_column(String(32), nullable=False)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    event_key: Mapped[str] = mapped_column(String(80), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=DELIVERY_PENDING, server_default=DELIVERY_PENDING
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Текст ошибки от Bot API, обрезанный до длины колонки. Секретов в нём нет.
    error: Mapped[str | None] = mapped_column(String(255), nullable=True)
