"""Telegram: привязка чата, подписки и очередь доставки.

Состояние живёт целиком в CRM: бот — тонкий воркер, который ходит в Bot API и
забирает из этих таблиц готовые сообщения. Публичного вебхука нет.

`chat_id` и `username` — персональные данные: они не попадают в логи, а при
отвязке строка не удаляется физически, а получает `revoked_at`. Так история
доставок остаётся целой, а сообщения человеку больше не уходят.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
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

# Вид доставки персонального правила (`notification_rules`). Подписки у него
# нет: правило адресовано своему владельцу, а не всем коллегам по организации.
NOTIFICATION_RULE_KIND = "notification_rule"

# Служебный вид тестового сообщения: подписки у него нет, оно всегда адресное.
# Отдельный код нужен, чтобы тестовая доставка не путалась с настоящим событием.
TELEGRAM_TEST_KIND = "telegram_test"

# Виды событий, о которых можно подписаться. Заголовки — для кабинета.
# У тестового сообщения подписки нет, но заголовок нужен: из него собирается
# первая строка сообщения, и человек не должен видеть там код `telegram_test`.
NOTIFICATION_KINDS = (RESIDENT_OUTFLOW_KIND,)
NOTIFICATION_KIND_TITLES = {
    RESIDENT_OUTFLOW_KIND: "Выселение проживающего",
    TELEGRAM_TEST_KIND: "Тестовое уведомление",
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


class NotificationRule(Base):
    """Персональное правило: событие в таблице общежития, отмеченное условиями.

    Правило принадлежит пользователю, а не организации: у каждого свой набор и
    своё название. `conditions` — JSON-список
    `{"column_id": int, "operator": str, "value": ...}`; пустой список означает
    «любая запись строки», а потолок в четыре условия держит домен
    (`app/notification_rules.py`), а не схема базы: у JSON нет длины.

    `table_key` — ключ таблицы ровно в том виде, в каком он ходит по API
    (`residents`, `inflow`, `custom_7`). Внешнего ключа на вкладку нет намеренно:
    удалённая вкладка оставляет правило «сломанным» (`broken` в ответе), а не
    уносит его вместе с историей доставок. По той же причине нет и FK на столбцы:
    архивированный столбец делает правило нерабочим, но не удаляет его.
    """

    __tablename__ = "notification_rules"
    __table_args__ = (Index("ix_notification_rules_dormitory_table", "dormitory_id", "table_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    dormitory_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("dormitories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    table_key: Mapped[str] = mapped_column(String(32), nullable=False)
    # Название человек пишет сам: сервер его не дополняет и не переписывает.
    # Оно же становится текстом сообщения в Telegram.
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    conditions: Mapped[list[dict[str, Any]]] = mapped_column(
        JSON, nullable=False, default=list, server_default="[]"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
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
    # Правило, событие которого породило доставку. `NULL` у событий без правила
    # (выселение, тестовое сообщение) и после удаления правила: `SET NULL`
    # сохраняет историю доставок, а не уносит её вместе с правилом.
    rule_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("notification_rules.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
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
