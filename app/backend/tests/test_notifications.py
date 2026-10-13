"""Уведомления: код привязки, получатели и очередь доставки — без HTTP и без сети.

Проверяется предметная логика `app/notifications.py`: одноразовость кода, выбор
получателей, идемпотентность события и переходы состояний очереди. Роуты и
клиент Bot API живут в `tests/test_telegram.py`, хук выселения — в
`tests/test_resident_outflow_notifications.py`.
"""

from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notifications
from app.models.activation import ActivationToken
from app.models.organization import OrganizationMember
from app.models.telegram import (
    DELIVERY_PENDING,
    RESIDENT_OUTFLOW_KIND,
    NotificationDelivery,
    TelegramLink,
)
from app.models.user import User
from tests.conftest import create_user, organizations_for


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


def test_subscriptions_default_to_enabled_and_can_be_switched(db_session: Session) -> None:
    user = create_user(db_session)
    assert notifications.subscriptions(db_session, user) == [(RESIDENT_OUTFLOW_KIND, True)]

    notifications.set_subscription(db_session, user, kind=RESIDENT_OUTFLOW_KIND, is_enabled=False)
    db_session.commit()
    assert notifications.subscriptions(db_session, user) == [(RESIDENT_OUTFLOW_KIND, False)]

    notifications.set_subscription(db_session, user, kind=RESIDENT_OUTFLOW_KIND, is_enabled=True)
    db_session.commit()
    assert notifications.subscriptions(db_session, user) == [(RESIDENT_OUTFLOW_KIND, True)]


def test_recipients_are_colleagues_with_a_live_chat(db_session: Session) -> None:
    actor = create_user(db_session, email="actor@example.com")
    organization, _ = organizations_for(db_session, actor)

    colleague = create_user(db_session, email="colleague@example.com")
    silent = create_user(db_session, email="silent@example.com")
    inactive = create_user(db_session, email="inactive@example.com", is_active=False)
    stranger = create_user(db_session, email="stranger@example.com")
    for user in (colleague, silent, inactive):
        db_session.add(
            OrganizationMember(organization_id=organization.id, user_id=user.id, role="manager")
        )
    db_session.commit()

    connect(db_session, actor, chat_id="1")
    connect(db_session, colleague, chat_id="2")
    connect(db_session, inactive, chat_id="3")
    connect(db_session, stranger, chat_id="4")

    assert [user.id for user, _ in notifications.recipients(db_session, actor.id)] == [colleague.id]

    # Отключённая подписка убирает коллегу из получателей.
    notifications.set_subscription(
        db_session, colleague, kind=RESIDENT_OUTFLOW_KIND, is_enabled=False
    )
    db_session.commit()
    assert notifications.recipients(db_session, actor.id) == []

    # Отвязка чата действует так же.
    notifications.set_subscription(
        db_session, colleague, kind=RESIDENT_OUTFLOW_KIND, is_enabled=True
    )
    notifications.unlink(db_session, colleague)
    db_session.commit()
    assert notifications.recipients(db_session, actor.id) == []


def test_outflow_queue_is_idempotent_and_skips_the_actor(db_session: Session) -> None:
    actor = create_user(db_session, email="actor@example.com")
    organization, _ = organizations_for(db_session, actor)
    colleague = create_user(db_session, email="colleague@example.com")
    db_session.add(
        OrganizationMember(organization_id=organization.id, user_id=colleague.id, role="admin")
    )
    db_session.commit()
    connect(db_session, actor, chat_id="1")
    connect(db_session, colleague, chat_id="2", username=None)

    event = notifications.ResidentOutflowEvent(
        resident_id=7,
        full_name="Иванов Иван",
        personnel_number="123",
        dormitory_name="Северное",
        hostel_name="Хостел 1",
        shift_start=date(2026, 10, 1),
        shift_end=None,
        departure_date=date(2026, 10, 9),
    )

    assert notifications.queue_resident_outflow(db_session, resident=event, actor_id=actor.id) == 1
    # Повтор того же события не создаёт вторую доставку.
    assert notifications.queue_resident_outflow(db_session, resident=event, actor_id=actor.id) == 0

    rows = list(db_session.scalars(select(NotificationDelivery)))
    assert len(rows) == 1
    assert rows[0].user_id == colleague.id
    assert rows[0].chat_id == "2"
    assert rows[0].event_key == "resident_outflow:7"
    assert rows[0].status == DELIVERY_PENDING
    assert rows[0].title == "Выселение проживающего"
    assert "Иванов Иван" in rows[0].body
    assert "123" in rows[0].body
    assert "Северное" in rows[0].body
    assert "2026-10-09" in rows[0].body


def test_render_falls_back_to_the_shift_end_and_unknown_names(db_session: Session) -> None:
    event = notifications.ResidentOutflowEvent(
        resident_id=1,
        full_name=None,
        personnel_number=None,
        dormitory_name=None,
        hostel_name=None,
        shift_start=None,
        shift_end=date(2026, 11, 1),
        departure_date=None,
    )
    title, body = notifications.render_resident_outflow(event)
    assert title == "Выселение проживающего"
    assert "без ФИО" in body
    assert "2026-11-01" in body


def test_pending_feed_transitions_between_states(db_session: Session) -> None:
    user = create_user(db_session)
    delivery = NotificationDelivery(
        user_id=user.id,
        chat_id="77",
        kind=RESIDENT_OUTFLOW_KIND,
        event_key="resident_outflow:1",
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
        kind=RESIDENT_OUTFLOW_KIND,
        event_key="resident_outflow:2",
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
