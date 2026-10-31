"""Пробный период кабинета (issue #39, #99, #117).

Критерии готовности разложены по тестам: активация начинает срок, `GET
/api/trial` честно сообщает остаток и закрытость, закрытый кабинет отвечает 403
на рабочих ручках и остаётся открытым для обзора, тарифов, организации и
профиля, а в организацию не пускают больше предела мест.

Предел мест не всегда пробный: с тарифом это `max_members` его яруса, на
пробном периоде — настройка `trial_member_limit`, а незаданная настройка значит
«предела нет» (умолчание, issue #117). Отказ один и тот же по виду: `409` с
заголовком `X-Member-Limit` и серверным текстом «Достигнут предел мест (N).
Перейдите на тариф «…»», поэтому проверяется он здесь же.

SMTP в тестах выключен (см. `conftest`), поэтому приглашения не ходят в сеть.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models.organization import Organization
from app.models.tariff import Tariff
from app.models.user import User
from app.security import ACTIVATION_REQUIRED_DETAIL, issue_activation_token
from app.subscription import MEMBER_LIMIT_HEADER, MEMBER_LIMIT_HEADER_VALUE
from app.trial import (
    TRIAL_EXPIRED_DETAIL,
    organization_has_tariff,
    trial_ends_at_for,
    trial_state,
)
from tests.conftest import create_user, login, organizations_for

NEW_PASSWORD = "trial-password-1"
# Дата в прошлом: так выглядит кабинет, у которого пробный период закончился.
EXPIRED = datetime(2020, 1, 1, tzinfo=UTC)
OWNER_EMAIL = "owner@example.com"
# Предел из настройки: им проверяется режим «предел задан», пока умолчание —
# «предела нет».
SETTING_LIMIT = 3


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


def set_tariff(
    db_session: Session,
    organization: Organization,
    max_members: int | None = None,
    ends_at: datetime | None = None,
    name: str = "Месяц",
) -> Tariff:
    """Назначить организации тариф: доступ больше не зависит от пробного периода."""
    tariff = Tariff(
        name=name,
        amount=Decimal("5000.00"),
        currency="RUB",
        period="month",
        max_members=max_members,
    )
    db_session.add(tariff)
    db_session.commit()
    organization.tariff_id = tariff.id
    organization.tariff_ends_at = ends_at
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


def test_trial_ends_at_for_follows_the_trial_days_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    """Длительность берётся из настройки, а не из числа в коде."""
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    monkeypatch.setenv("TRIAL_DAYS", "7")
    get_settings.cache_clear()
    try:
        assert trial_ends_at_for(now) == now + timedelta(days=7)
    finally:
        get_settings.cache_clear()


def test_trial_defaults_are_two_weeks_without_a_member_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Умолчания без окружения: 14 суток и «предела сотрудников нет»."""
    monkeypatch.delenv("TRIAL_DAYS", raising=False)
    monkeypatch.delenv("TRIAL_MEMBER_LIMIT", raising=False)

    settings = Settings(
        _env_file=None,
        database_url="sqlite+pysqlite:///:memory:",
        jwt_secret="unit-test-secret-value-0123456789",
    )

    assert settings.trial_days == 14
    assert settings.trial_member_limit is None


def test_trial_member_limit_rejects_a_non_positive_value() -> None:
    """`0` — не «предела нет», а невозможное состояние: старт падает сразу."""
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            database_url="sqlite+pysqlite:///:memory:",
            jwt_secret="unit-test-secret-value-0123456789",
            trial_member_limit=0,
        )


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
    # Умолчание настройки — «предела нет», а не число в коде.
    assert state.member_limit is None
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
    # Живой клиент не подставляет своё число: сервер честно говорит «предела нет».
    assert payload["member_limit"] is None
    assert payload["ends_at"] is not None
    days_left = payload["days_left"]
    assert isinstance(days_left, int)
    trial_days = get_settings().trial_days
    assert trial_days - 1 <= days_left <= trial_days


def test_trial_endpoint_describes_an_expired_period(
    client: TestClient, db_session: Session
) -> None:
    owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)

    payload = trial_payload(client)

    assert payload["locked"] is True
    assert payload["is_active"] is False
    assert payload["days_left"] == 0
    assert payload["member_limit"] is None


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


def test_expired_tariff_closes_the_cabinet(client: TestClient, db_session: Session) -> None:
    """Проданный тариф больше не бессрочен: кончился срок — кабинет закрыт."""
    _, organization = owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)
    set_tariff(db_session, organization, ends_at=EXPIRED)

    response = client.get("/api/dormitories")

    assert response.status_code == 403
    assert response.json()["detail"] == TRIAL_EXPIRED_DETAIL
    assert trial_payload(client)["locked"] is True
    # Данные целы: обзор и разделы организации по-прежнему открыты.
    assert client.get("/api/organization").status_code == 200


def test_paid_future_period_keeps_the_cabinet_open(client: TestClient, db_session: Session) -> None:
    """Будущий период оплачен — кабинет открыт без фонового воркера."""
    _, organization = owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)
    set_tariff(db_session, organization, ends_at=EXPIRED)
    future = Tariff(
        name="Квартал",
        amount=Decimal("13200.00"),
        currency="RUB",
        period="quarter",
    )
    db_session.add(future)
    db_session.commit()
    organization.next_tariff_id = future.id
    organization.next_tariff_ends_at = datetime.now(UTC) + timedelta(days=60)
    db_session.commit()

    assert client.get("/api/dormitories").status_code == 200
    assert trial_payload(client)["locked"] is False
    current = client.get("/api/tariffs/current").json()
    assert current["tariff"]["id"] == future.id
    # Слот продления свободен: будущий период уже стал действующим.
    assert current["next"] is None


def test_inactive_cabinet_keeps_its_own_403_text(client: TestClient, db_session: Session) -> None:
    """Активация и пробный период — разные отказы, и текст у них разный."""
    user = create_user(db_session, is_active=False, trial_active=False)
    assert login(client, user.email).status_code == 200

    response = client.get("/api/dormitories")

    assert response.status_code == 403
    assert response.json()["detail"] == ACTIVATION_REQUIRED_DETAIL


# --- 4. Предел мест -----------------------------------------------------------


def add_price_row(
    db_session: Session,
    name: str,
    max_members: int | None,
    position: int,
    group_code: str | None = None,
) -> Tariff:
    """Строка публичного прайса: из неё берётся тариф для подсказки в отказе."""
    tariff = Tariff(
        name=name,
        amount=Decimal("4900.00"),
        currency="RUB",
        period="month",
        position=position,
        is_visible=True,
        max_members=max_members,
        group_code=group_code,
    )
    db_session.add(tariff)
    db_session.commit()
    db_session.refresh(tariff)
    return tariff


def test_trial_without_a_limit_accepts_the_fourth_and_tenth_employee(
    client: TestClient, db_session: Session
) -> None:
    """Умолчание «предела нет»: на пробном периоде приглашать можно сколько угодно."""
    owner_ready(client, db_session)

    for index in range(10):
        invited = invite(client, f"worker{index}@example.com")
        assert invited.status_code == 201, invited.text

    payload = trial_payload(client)
    assert payload["is_active"] is True
    assert payload["member_limit"] is None
    members = client.get("/api/organization/members").json()
    assert len(members) == 11  # владелец и десять приглашённых


def test_configured_trial_member_limit_points_at_the_next_tier(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`TRIAL_MEMBER_LIMIT=3` возвращает предел: отказ и подсказка яруса — как раньше."""
    monkeypatch.setenv("TRIAL_MEMBER_LIMIT", str(SETTING_LIMIT))
    # `get_settings()` кеширован: без сброса кейс молча проверял бы умолчание.
    get_settings.cache_clear()
    try:
        owner_ready(client, db_session)
        add_price_row(db_session, "Старт", 5, 11, group_code="start")
        add_price_row(db_session, "Рост", 15, 21, group_code="growth")

        assert trial_payload(client)["member_limit"] == SETTING_LIMIT
        for index in range(SETTING_LIMIT):
            assert invite(client, f"worker{index}@example.com").status_code == 201

        refused = invite(client, "chetvertyi@example.com")

        assert refused.status_code == 409, refused.text
        assert refused.json()["detail"] == (
            f"Достигнут предел мест ({SETTING_LIMIT}). Перейдите на тариф «Старт»"
        )
        assert refused.headers[MEMBER_LIMIT_HEADER] == MEMBER_LIMIT_HEADER_VALUE
    finally:
        get_settings.cache_clear()


def test_tariff_member_limit_blocks_the_invitation(client: TestClient, db_session: Session) -> None:
    """Предел берётся у действующего тарифа, а не у пробного периода."""
    _, organization = owner_ready(client, db_session)
    set_tariff(db_session, organization, max_members=2)
    add_price_row(db_session, "Рост", 15, 21, group_code="growth")

    for index in range(2):
        assert invite(client, f"worker{index}@example.com").status_code == 201

    refused = invite(client, "tretii@example.com")

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"] == "Достигнут предел мест (2). Перейдите на тариф «Рост»"
    assert refused.headers[MEMBER_LIMIT_HEADER] == MEMBER_LIMIT_HEADER_VALUE


def test_lower_limit_never_evicts_existing_employees(
    client: TestClient, db_session: Session
) -> None:
    """Понижение предела никого не выгоняет: блокируются только приглашения."""
    owner, organization = owner_ready(client, db_session)
    set_tariff(db_session, organization, max_members=None)
    for index in range(4):
        assert invite(client, f"worker{index}@example.com").status_code == 201

    organization.tariff_id = None
    organization.tariff_ends_at = None
    db_session.commit()
    set_tariff(db_session, organization, max_members=2, name="Старт")

    refused = invite(client, "pyatyi@example.com")

    assert refused.status_code == 409
    # Прежние сотрудники на месте: лимит считается по ним, но он никого не удалил.
    members = client.get("/api/organization/members").json()
    assert len(members) == 5  # владелец и четыре приглашённых
    assert owner.trial_ends_at is not None


def test_unlimited_tier_removes_the_member_limit(client: TestClient, db_session: Session) -> None:
    """`max_members = NULL` — без лимита: приглашать можно сколько угодно."""
    _, organization = owner_ready(client, db_session)
    set_tariff(db_session, organization, max_members=None)

    for index in range(5):
        invited = invite(client, f"worker{index}@example.com")
        assert invited.status_code == 201, invited.text


def test_email_conflict_has_no_member_limit_header(client: TestClient, db_session: Session) -> None:
    owner_ready(client, db_session)
    create_user(db_session, email="zanyat@example.com")

    response = invite(client, "zanyat@example.com")

    assert response.status_code == 409, response.text
    assert MEMBER_LIMIT_HEADER not in response.headers


def test_tariff_takes_priority_over_the_trial_member_limit(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Действующий тариф главнее пробной настройки: у тарифа свой `max_members`.

    Без заданного `TRIAL_MEMBER_LIMIT` кейс неотличим от безлимитного яруса
    (`test_unlimited_tier_removes_the_member_limit`), поэтому настройка здесь
    выставлена: только так видно, что `_member_limit` берёт предел у тарифа, а
    не у пробного периода. Иначе настройка на стенде тихо обрезала бы места
    платящему клиенту.
    """
    monkeypatch.setenv("TRIAL_MEMBER_LIMIT", str(SETTING_LIMIT))
    # `get_settings()` кеширован: сброс до и после подмены окружения.
    get_settings.cache_clear()
    try:
        _, organization = owner_ready(client, db_session)
        # Тариф без явного предела мест: пробная настройка не должна его подменить.
        set_tariff(db_session, organization)

        for index in range(6):
            invited = invite(client, f"worker{index}@example.com")
            assert invited.status_code == 201, invited.text
    finally:
        get_settings.cache_clear()


def test_locked_cabinet_still_lets_the_owner_invite(
    client: TestClient, db_session: Session
) -> None:
    """Раздел «Организация» открыт на закрытом кабинете — значит и приглашения."""
    owner_ready(client, db_session, trial_active=False, trial_ends_at=EXPIRED)

    response = invite(client, "novyi@example.com")

    assert response.status_code == 201, response.text
