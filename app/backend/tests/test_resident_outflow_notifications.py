"""Хук выселения: доставки коллегам, актору — ничего, повтор не дублирует.

Проверяется связка ручки `POST /api/dormitories/{id}/residents/{id}/outflow` с
очередью уведомлений: сколько доставок появляется, кому и что происходит при
повторном вызове хука по тому же проживающему.
"""

from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import notifications
from app.models.organization import OrganizationMember
from app.models.telegram import RESIDENT_OUTFLOW_KIND, NotificationDelivery
from app.models.user import User
from tests.conftest import create_user, organizations_for
from tests.test_resident_outflow import move, preview
from tests.test_resident_payments import setup

# Почта актора совпадает с той, что создаёт `setup` через `sign_in`.
ACTOR_EMAIL = "worker@example.com"


def connect(db_session: Session, user: User, *, chat_id: str) -> None:
    """Подключить пользователю Telegram: тот же путь, что у ручки бота."""
    code, _ = notifications.issue_link_code(db_session, user)
    db_session.commit()
    assert notifications.link_chat(db_session, code=code, chat_id=chat_id, username="ivan")
    db_session.commit()


def test_outflow_notifies_colleagues_except_the_actor_and_only_once(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident = setup(client, db_session)
    actor = db_session.scalar(select(User).where(User.email == ACTOR_EMAIL))
    assert actor is not None
    organization, _ = organizations_for(db_session, actor)

    colleague = create_user(db_session, email="colleague@example.com")
    db_session.add(
        OrganizationMember(organization_id=organization.id, user_id=colleague.id, role="manager")
    )
    db_session.commit()
    connect(db_session, colleague, chat_id="555")
    # Актор тоже подключён: уведомление о своём же действии он получать не должен.
    connect(db_session, actor, chat_id="777")

    plan = preview(client, dorm, resident)
    assert move(client, dorm, resident, plan).status_code == 201

    rows = list(db_session.scalars(select(NotificationDelivery)))
    assert [row.user_id for row in rows] == [colleague.id]
    assert rows[0].chat_id == "555"
    assert rows[0].kind == RESIDENT_OUTFLOW_KIND
    assert rows[0].event_key == f"{RESIDENT_OUTFLOW_KIND}:{resident}"
    assert "Иванов Иван" in rows[0].body

    # Повтор хука по тому же проживающему второй доставки не создаёт.
    event = notifications.ResidentOutflowEvent(
        resident_id=resident,
        full_name="Иванов Иван",
        personnel_number="123",
        dormitory_name="Северное",
        hostel_name=None,
        shift_start=None,
        shift_end=date(2026, 10, 9),
        departure_date=date(2026, 10, 9),
    )
    assert notifications.queue_resident_outflow(db_session, resident=event, actor_id=actor.id) == 0
    assert len(list(db_session.scalars(select(NotificationDelivery)))) == 1


def test_outflow_without_connected_colleagues_queues_nothing(
    client: TestClient, db_session: Session
) -> None:
    dorm, resident = setup(client, db_session)

    plan = preview(client, dorm, resident)

    assert move(client, dorm, resident, plan).status_code == 201
    assert list(db_session.scalars(select(NotificationDelivery))) == []
