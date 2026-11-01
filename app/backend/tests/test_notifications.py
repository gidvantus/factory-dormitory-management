"""Уведомления: код привязки и очередь доставки — без HTTP и без сети.

Проверяется предметная логика `app/notifications.py`: одноразовость кода,
переходы состояний очереди и список чатов для бота. Роуты и клиент Bot API живут
в `tests/test_telegram.py`.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notifications
from app.models.activation import ActivationToken
from app.models.telegram import TELEGRAM_TEST_KIND, NotificationDelivery, TelegramLink
from app.models.user import User
from tests.conftest import create_user


def connect(
    db_session: Session, user: User, *, chat_id: str = "100500", username: str | None = "ivan"
) -> None:
    """Подключить пользователю Telegram так же, как это делает ручка бота."""
    code, _ = notifications.issue_link_code(db_session, user)
    db_session.commit()
    assert notifications.link_chat(db_session, code=code, chat_id=chat_id, username=username)
    db_session.commit()


def link_code_record(db_session: Session) -> ActivationToken:
    """Единственная строка кода привязки: в базе лежит хеш, а не открытый код."""
    record = db_session.scalar(
        select(ActivationToken).where(ActivationToken.kind == "telegram_link")
    )
    assert record is not None
    return record


def test_link_code_is_stored_as_a_hash_and_works_once(db_session: Session) -> None:
    user = create_user(db_session)
    code, expires_at = notifications.issue_link_code(db_session, user)
    db_session.commit()

    assert expires_at > datetime.now(UTC)
    assert link_code_record(db_session).token_hash != code

    linked = notifications.link_chat(db_session, code=code, chat_id="42", username="ivan")
    assert linked is not None and linked.id == user.id
    db_session.commit()

    # Тот же код второй раз не срабатывает: он одноразовый.
    assert notifications.link_chat(db_session, code=code, chat_id="43", username=None) is None
    # И случайная строка тоже.
    assert (
        notifications.link_chat(db_session, code="нет-такого-кода", chat_id="44", username=None)
        is None
    )


def test_expired_code_is_rejected(db_session: Session) -> None:
    user = create_user(db_session)
    code, _ = notifications.issue_link_code(db_session, user)
    record = link_code_record(db_session)
    record.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    db_session.commit()

    assert notifications.link_chat(db_session, code=code, chat_id="42", username=None) is None
    assert not list(db_session.scalars(select(TelegramLink)))


def test_relinking_keeps_a_single_row_and_revives_it(db_session: Session) -> None:
    user = create_user(db_session)
    connect(db_session, user, chat_id="1", username="first")
    notifications.unlink(db_session, user)
    db_session.commit()
    assert notifications.link_status(db_session, user) == (False, None)

    connect(db_session, user, chat_id="2", username="second")

    links = list(db_session.scalars(select(TelegramLink)))
    assert len(links) == 1
    assert links[0].chat_id == "2"
    assert links[0].revoked_at is None
    assert notifications.link_status(db_session, user) == (True, "second")


def test_unlink_keeps_the_row_and_does_not_move_the_mark(db_session: Session) -> None:
    user = create_user(db_session)
    connect(db_session, user)
    notifications.unlink(db_session, user)
    db_session.commit()
    row = db_session.scalar(select(TelegramLink))
    assert row is not None
    first_mark = row.revoked_at
    assert first_mark is not None

    # Повторная отвязка уже отвязанного — не ошибка и не сдвигает отметку.
    notifications.unlink(db_session, user)
    db_session.commit()
    assert row.revoked_at == first_mark


def test_connected_chats_lists_only_live_links(db_session: Session) -> None:
    """Боту нужны чаты всех живых привязок: иначе доставки ждут сообщения человека."""
    first = create_user(db_session, email="first@example.com")
    second = create_user(db_session, email="second@example.com")
    connect(db_session, first, chat_id="1")
    connect(db_session, second, chat_id="2")
    assert notifications.connected_chats(db_session) == ["1", "2"]

    notifications.unlink(db_session, first)
    db_session.commit()

    assert notifications.connected_chats(db_session) == ["2"]


def test_pending_feed_transitions_between_states(db_session: Session) -> None:
    user = create_user(db_session)
    delivery = NotificationDelivery(
        user_id=user.id,
        chat_id="77",
        kind=TELEGRAM_TEST_KIND,
        event_key="telegram_test:1",
        title="Заголовок",
        body="Текст",
    )
    db_session.add(delivery)
    db_session.commit()

    pending = notifications.pending_for_chat(db_session, "77")
    assert [row.id for row in pending] == [delivery.id]
    assert notifications.pending_for_chat(db_session, "другой-чат") == []

    notifications.mark_sent(db_session, [delivery.id])
    db_session.commit()
    assert notifications.pending_for_chat(db_session, "77") == []

    failed = NotificationDelivery(
        user_id=user.id,
        chat_id="77",
        kind=TELEGRAM_TEST_KIND,
        event_key="telegram_test:2",
        title="Заголовок",
        body="Текст",
    )
    db_session.add(failed)
    db_session.commit()
    notifications.mark_failed(db_session, failed.id, "о" * 400)

    db_session.refresh(failed)
    assert failed.status == "failed"
    assert failed.error is not None and len(failed.error) == 255
    assert notifications.pending_for_chat(db_session, "77") == []
