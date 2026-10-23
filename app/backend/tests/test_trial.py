"""Пробный период кабинета (issue #39).

Критерии готовности разложены по тестам: активация начинает месяц, `GET
/api/trial` честно сообщает остаток и закрытость, закрытый кабинет отвечает 403
на рабочих ручках и остаётся открытым для обзора, тарифов, организации и
профиля, а на пробном периоде в организацию не пускают больше трёх сотрудников.

SMTP в тестах выключен (см. `conftest`), поэтому приглашения не ходят в сеть.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.organization import Organization
from app.models.tariff import Tariff
from app.models.user import User
from app.security import ACTIVATION_REQUIRED_DETAIL, issue_activation_token
from app.trial import (
    TRIAL_EXPIRED_DETAIL,
    TRIAL_LIMIT_HEADER,
    TRIAL_LIMIT_HEADER_VALUE,
    TRIAL_MEMBER_LIMIT,
    TRIAL_MEMBER_LIMIT_DETAIL,
    organization_has_tariff,
    trial_ends_at_for,
    trial_state,
)
from tests.conftest import create_user, login, organizations_for

NEW_PASSWORD = "trial-password-1"
# Дата в прошлом: так выглядит кабинет, у которого пробный период закончился.
EXPIRED = datetime(2020, 1, 1, tzinfo=UTC)
OWNER_EMAIL = "owner@example.com"


def as_utc(value: datetime) -> datetime:
    """SQLite отдаёт naive datetime: для сравнений считаем его UTC."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def owner_ready(
    client: TestClient,
    db_session: Session,
    *,
    trial_active: bool = True,
    trial_ends_at: datetime | None = None,
) -> tuple[User, Organization]:
    """Владелец с организацией без тарифа, вошедший в кабинет."""
    owner = create_user(
        db_session,
        email=OWNER_EMAIL,
        trial_active=trial_active,
        trial_ends_at=trial_ends_at,
    )
    organization, _ = organizations_for(db_session, owner, name="ООО Ромашка")
    assert login(client, owner.email).status_code == 200
    return owner, organization


def set_tariff(db_session: Session, organization: Organization) -> Tariff:
    """Назначить организации тариф: доступ больше не зависит от пробного периода."""
    tariff = Tariff(name="Месяц", amount=Decimal("5000.00"), currency="RUB", period="month")
    db_session.add(tariff)
    db_session.commit()
    organization.tariff_id = tariff.id
    db_session.commit()
    return tariff


def trial_payload(client: TestClient) -> dict[str, object]:
    response = client.get("/api/trial")
    assert response.status_code == 200, response.text
    return response.json()


def invite(client: TestClient, email: str, role: str = "manager") -> Response:
    return client.post(
        "/api/organization/invitations",
        json={"email": email, "full_name": "Петров Пётр", "role": role},
    )


# --- 1. Активация начинает пробный период ------------------------------------


def test_activation_fills_the_trial_end(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, is_active=False, trial_active=False)
    assert user.trial_ends_at is None
    raw_token = issue_activation_token(db_session, user.id)
    db_session.commit()
    before = datetime.now(UTC)

    response = client.post(
        "/api/auth/activate",
        json={
            "token": raw_token,
            "password": NEW_PASSWORD,
            "consent": True,
            "terms_accepted": True,
        },
    )

    assert response.status_code == 200, response.text
    db_session.refresh(user)
    assert user.trial_ends_at is not None
    expected = before + timedelta(days=get_settings().trial_days)
    assert abs((as_utc(user.trial_ends_at) - expected).total_seconds()) < 60


def test_trial_ends_at_for_adds_the_configured_days() -> None:
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    assert trial_ends_at_for(now) == now + timedelta(days=get_settings().trial_days)


# --- 2. Состояние пробного периода -------------------------------------------


def test_trial_state_rounds_days_up_and_reports_the_limit(db_session: Session) -> None:
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    user = create_user(
        db_session,
        trial_active=False,
        trial_ends_at=now + timedelta(days=2, hours=1),
    )

    state = trial_state(db_session, user, now=now)

    assert state.days_left == 3
    assert state.is_active is True
    assert state.locked is False
    assert state.member_limit == TRIAL_MEMBER_LIMIT
    assert state.ends_at == now + timedelta(days=2, hours=1)
    assert state.started_at == state.ends_at - timedelta(days=get_settings().trial_days)


def test_trial_state_of_an_expired_period_is_locked(db_session: Session) -> None:
    user = create_user(db_session, trial_active=False, trial_ends_at=EXPIRED)

    state = trial_state(db_session, user)

    assert state.locked is True
    assert state.is_active is False
    assert state.days_left == 0
    assert state.ends_at == EXPIRED


def test_trial_state_without_a_period_is_locked(db_session: Session) -> None:
    """Пустая дата — «периода нет», а не «ещё не начался»: доступа она не даёт."""
    user = create_user(db_session, trial_active=False)

    state = trial_state(db_session, user)

    assert state.locked is True
    assert state.is_active is False
    assert state.ends_at is None
    assert state.started_at is None
    assert state.days_left == 0


def test_organization_has_tariff_needs_a_linked_organization(db_session: Session) -> None:
    lonely = create_user(db_session, trial_active=False)
    assert organization_has_tariff(db_session, lonely) is False

    owner, organization = owner_ready_user(db_session)
    assert organization_has_tariff(db_session, owner) is False
    set_tariff(db_session, organization)
    assert organization_has_tariff(db_session, owner) is True


def owner_ready_user(db_session: Session) -> tuple[User, Organization]:
    """Владелец с организацией без сессии: для юнит-проверок состояния."""
    owner = create_user(db_session, email=OWNER_EMAIL, trial_active=False)
    organization, _ = organizations_for(db_session, owner, name="ООО Ромашка")
    return owner, organization


def test_trial_endpoint_describes_a_running_period(client: TestClient, db_session: Session) -> None:
    owner_ready(client, db_session)

    payload = trial_payload(client)

    assert payload["locked"] is False
    assert payload["is_active"] is True
    assert payload["member_limit"] == TRIAL_MEMBER_LIMIT
    assert payload["ends_at"] is not None
    days_left = payload["days_left"]
    assert isinstance(days_left, int)
    assert 28 <= days_left <= 30


def test_trial_endpoint_describes_an_expired_period(
    client: TestClient, db_session: Session
) -> None:
    owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)

    payload = trial_payload(client)

    assert payload["locked"] is True
    assert payload["is_active"] is False
    assert payload["days_left"] == 0
    assert payload["member_limit"] == TRIAL_MEMBER_LIMIT


def test_tariff_opens_a_cabinet_with_an_expired_trial(
    client: TestClient, db_session: Session
) -> None:
    _, organization = owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)
    set_tariff(db_session, organization)

    payload = trial_payload(client)

    assert payload["locked"] is False
    assert payload["is_active"] is False


def test_tariff_during_the_trial_removes_the_trial_limits(
    client: TestClient, db_session: Session
) -> None:
    _, organization = owner_ready(client, db_session)
    set_tariff(db_session, organization)

    payload = trial_payload(client)

    assert payload["locked"] is False
    assert payload["is_active"] is False


def test_trial_endpoint_needs_an_activated_cabinet(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, is_active=False, trial_active=False)
    assert login(client, user.email).status_code == 200

    response = client.get("/api/trial")

    assert response.status_code == 403
    assert response.json()["detail"] == ACTIVATION_REQUIRED_DETAIL


# --- 3. Закрытый кабинет -----------------------------------------------------

CLOSED_REQUESTS = (
    ("GET", "/api/dormitories"),
    ("GET", "/api/dashboard?from=2026-01-01&to=2026-01-02"),
    ("GET", "/api/statistics/reports"),
    ("GET", "/api/dormitory-tab-catalog"),
    # Импорт «Размещение персонала» — часть рабочего раздела «Общежития», а не отдельная ручка:
    # он пришёл на ветку вместе с develop-m и обязан закрываться тем же 403.
    ("GET", "/api/dormitories/1/hostels/import/template?month=2026-01-01"),
)

OPEN_REQUESTS = (
    ("GET", "/api/me"),
    ("GET", "/api/trial"),
    ("GET", "/api/tariffs"),
    ("GET", "/api/tariffs/current"),
    ("GET", "/api/organization"),
    ("GET", "/api/organization/members"),
)


def test_locked_cabinet_closes_the_working_sections(
    client: TestClient, db_session: Session
) -> None:
    owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)

    for method, path in CLOSED_REQUESTS:
        response = client.request(method, path)
        assert response.status_code == 403, f"{method} {path}: {response.status_code}"
        assert response.json()["detail"] == TRIAL_EXPIRED_DETAIL, f"{method} {path}"


def test_locked_cabinet_keeps_the_overview_and_the_account_sections(
    client: TestClient, db_session: Session
) -> None:
    owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)

    for method, path in OPEN_REQUESTS:
        response = client.request(method, path)
        assert response.status_code == 200, f"{method} {path}: {response.text}"


def test_tariff_reopens_the_working_sections(client: TestClient, db_session: Session) -> None:
    _, organization = owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)
    set_tariff(db_session, organization)

    assert client.get("/api/dormitories").status_code == 200


def test_inactive_cabinet_keeps_its_own_403_text(client: TestClient, db_session: Session) -> None:
    """Активация и пробный период — разные отказы, и текст у них разный."""
    user = create_user(db_session, is_active=False, trial_active=False)
    assert login(client, user.email).status_code == 200

    response = client.get("/api/dormitories")

    assert response.status_code == 403
    assert response.json()["detail"] == ACTIVATION_REQUIRED_DETAIL


# --- 4. Лимит сотрудников на пробном периоде ---------------------------------


def test_trial_member_limit_blocks_the_fourth_employee(
    client: TestClient, db_session: Session
) -> None:
    owner_ready(client, db_session)

    for index in range(TRIAL_MEMBER_LIMIT):
        invited = invite(client, f"worker{index}@example.com")
        assert invited.status_code == 201, invited.text

    refused = invite(client, "chetvertyi@example.com")

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == TRIAL_MEMBER_LIMIT_DETAIL
    assert refused.headers[TRIAL_LIMIT_HEADER] == TRIAL_LIMIT_HEADER_VALUE


def test_email_conflict_has_no_trial_limit_header(client: TestClient, db_session: Session) -> None:
    owner_ready(client, db_session)
    create_user(db_session, email="zanyat@example.com")

    response = invite(client, "zanyat@example.com")

    assert response.status_code == 409, response.text
    assert TRIAL_LIMIT_HEADER not in response.headers


def test_tariff_removes_the_member_limit(client: TestClient, db_session: Session) -> None:
    _, organization = owner_ready(client, db_session)
    set_tariff(db_session, organization)

    for index in range(TRIAL_MEMBER_LIMIT + 1):
        invited = invite(client, f"worker{index}@example.com")
        assert invited.status_code == 201, invited.text


def test_locked_cabinet_still_lets_the_owner_invite(
    client: TestClient, db_session: Session
) -> None:
    """Раздел «Организация» открыт на закрытом кабинете — значит и приглашения."""
    owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)

    response = invite(client, "novyi@example.com")

    assert response.status_code == 201, response.text
