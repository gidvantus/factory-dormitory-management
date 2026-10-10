"""Приглашение сотрудников в организацию по email с выбором роли (issue #23).

Критерии готовности разложены по тестам по порядку: владелец приглашает
сотрудника, появляется неактивная учётная запись, членство в **его**
организации и живая ссылка вида `invitation`; письмо уходит из шаблона
`invitation` с абсолютной ссылкой; переход по ссылке вводит приглашённого в
организацию владельца, не создавая второй; повторный переход — 410; занятый
email — 409 без новых строк; роли `owner` и `member` — 422; доступ к списку
участников закрыт 401 и 403.

SMTP не ходит в сеть: `smtplib.SMTP_SSL` подменён фейком, а фоновая задача
получает сессию тестовой базы — иначе она открыла бы своё соединение с пустой
базой в памяти и не нашла там шаблон письма.
"""

import logging
import re
import smtplib
from collections.abc import Iterator
from email.message import EmailMessage
from typing import Any, ClassVar

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from app import mail
from app.config import get_settings
from app.mail import INVITATION_TEMPLATE_CODE
from app.models.activation import ActivationToken
from app.models.mail_template import MailTemplate
from app.models.organization import Organization, OrganizationMember
from app.models.user import User
from app.security import create_access_token, hash_activation_token
from tests.conftest import create_user, login, organizations_for

NEW_PASSWORD = "invited-password-1"
OWNER_EMAIL = "owner@example.com"
INVITEE_EMAIL = "novyi@example.com"
INVITEE_NAME = "Петров Пётр"
INVITATION_URL = "https://domovoy.example"
SUBJECT = "Приглашение в систему «Домовой»"
BODY = (
    "Здравствуйте, {full_name}!\n"
    "Вас пригласили в организацию. Задайте пароль: {activation_url}\n"
    "Ссылка живёт {expires_hours} ч.\n"
)
LINK_PATTERN = re.compile(r"https://domovoy\.example/activate/([A-Za-z0-9_\-]+)")


class FakeSMTP:
    """Минимальная замена `smtplib.SMTP_SSL`: запоминает отправленные письма."""

    sent: ClassVar[list[EmailMessage]] = []

    def __init__(self, host: str, port: int, timeout: float | None = None) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout

    def __enter__(self) -> "FakeSMTP":
        return self

    def __exit__(self, *exc_info: object) -> None:
        return None

    def login(self, user: str, password: str) -> None:
        return None

    def send_message(self, message: EmailMessage) -> None:
        FakeSMTP.sent.append(message)

    @classmethod
    def reset(cls) -> None:
        cls.sent = []


@pytest.fixture(autouse=True)
def invitation_mail(monkeypatch: pytest.MonkeyPatch, db_engine: Engine) -> Iterator[type[FakeSMTP]]:
    """Настроенный SMTP, фейковая отправка и сессия тестовой базы для фоновой задачи.

    Кеш настроек сбрасывается и на выходе: иначе конфигурация этого теста
    пережила бы его и соседние тесты пошли бы в настоящий SMTP.
    """
    FakeSMTP.reset()
    monkeypatch.setattr(
        mail,
        "SessionLocal",
        sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False),
    )
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "465")
    monkeypatch.setenv("SMTP_USER", "robot@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("SMTP_FROM", "robot@example.com")
    monkeypatch.setenv("SMTP_USE_TLS", "true")
    monkeypatch.setenv("FRONTEND_BASE_URL", INVITATION_URL)
    get_settings.cache_clear()
    yield FakeSMTP
    FakeSMTP.reset()
    get_settings.cache_clear()


def seed_invitation_template(db_session: Session) -> MailTemplate:
    """Шаблон письма-приглашения: в тестовой базе миграции не выполняются."""
    template = MailTemplate(code=INVITATION_TEMPLATE_CODE, subject=SUBJECT, body=BODY)
    db_session.add(template)
    db_session.commit()
    db_session.refresh(template)
    return template


def owner_ready(
    client: TestClient, db_session: Session, email: str = OWNER_EMAIL
) -> tuple[User, Organization]:
    """Владелец с организацией, вошедший в кабинет."""
    owner = create_user(db_session, email=email)
    organization, _ = organizations_for(db_session, owner, name="ООО Ромашка")
    assert login(client, owner.email).status_code == 200
    return owner, organization


def invite(
    client: TestClient,
    *,
    email: str = INVITEE_EMAIL,
    full_name: str = INVITEE_NAME,
    role: str = "commandant",
) -> Response:
    return client.post(
        "/api/organization/invitations",
        json={"email": email, "full_name": full_name, "role": role},
    )


def invited_user(db_session: Session, email: str = INVITEE_EMAIL) -> User:
    user = db_session.scalar(select(User).where(User.email == email))
    assert user is not None, f"пользователя {email} нет в базе"
    return user


def invitation_token(db_session: Session, email: str = INVITEE_EMAIL) -> str:
    """Открытый токен из письма: в базе лежит только его хеш."""
    (message,) = FakeSMTP.sent
    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    match = LINK_PATTERN.search(plain.get_content())
    assert match is not None, plain.get_content()

    token = match.group(1)
    record = db_session.scalar(
        select(ActivationToken).where(ActivationToken.user_id == invited_user(db_session, email).id)
    )
    assert record is not None
    assert record.token_hash == hash_activation_token(token)
    return token


def count(db_session: Session, model: Any) -> int:
    return db_session.scalar(select(func.count()).select_from(model)) or 0


def activate(client: TestClient, token: str, password: str = NEW_PASSWORD) -> Response:
    return client.post("/api/auth/activate", json={"token": token, "password": password})


# --- 1. Приглашение создаёт неактивного сотрудника в организации владельца ---


def test_invitation_creates_an_inactive_user_membership_and_token(
    client: TestClient, db_session: Session
) -> None:
    _, organization = owner_ready(client, db_session)

    response = invite(client, email="Novyi@Example.com", full_name="  Петров   Пётр ")

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["email"] == INVITEE_EMAIL  # email нормализован
    assert body["full_name"] == INVITEE_NAME  # пробелы схлопнуты
    assert body["role"] == "commandant"
    assert body["is_active"] is False
    assert body["created_at"]
    assert isinstance(body["id"], int)

    invited = invited_user(db_session)
    assert invited.is_active is False
    assert invited.active_organization_id == organization.id

    membership = db_session.scalar(
        select(OrganizationMember).where(OrganizationMember.user_id == invited.id)
    )
    assert membership is not None
    assert membership.organization_id == organization.id
    assert membership.role == "commandant"

    token = db_session.scalar(select(ActivationToken).where(ActivationToken.user_id == invited.id))
    assert token is not None
    assert token.kind == "invitation"
    assert token.used_at is None


def test_invitation_keeps_the_owners_own_membership(
    client: TestClient, db_session: Session
) -> None:
    owner, organization = owner_ready(client, db_session)

    assert invite(client).status_code == 201

    owner_membership = db_session.scalar(
        select(OrganizationMember).where(OrganizationMember.user_id == owner.id)
    )
    assert owner_membership is not None
    assert owner_membership.role == "owner"
    assert owner_membership.organization_id == organization.id
    assert count(db_session, Organization) == 1


# --- 2. Письмо берётся из шаблона `invitation` и несёт абсолютную ссылку -----


def test_invitation_email_uses_the_invitation_template(
    client: TestClient, db_session: Session
) -> None:
    seed_invitation_template(db_session)
    owner_ready(client, db_session)

    assert invite(client).status_code == 201

    (message,) = FakeSMTP.sent
    assert message["To"] == INVITEE_EMAIL
    assert message["Subject"] == SUBJECT

    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    text = plain.get_content()
    assert INVITEE_NAME in text
    assert str(get_settings().activation_token_ttl_hours) in text
    assert LINK_PATTERN.search(text) is not None
    assert "{activation_url}" not in text


def test_invitation_email_skips_an_unknown_placeholder(
    client: TestClient, db_session: Session
) -> None:
    """Текст письма правят в базе: незнакомый плейсхолдер не должен ломать отправку."""
    template = seed_invitation_template(db_session)
    template.body = template.body + "Роль: {role_name}\n"
    db_session.commit()
    owner_ready(client, db_session)

    assert invite(client).status_code == 201

    (message,) = FakeSMTP.sent
    plain = message.get_body(preferencelist=("plain",))
    assert plain is not None
    text = plain.get_content()
    assert "Роль:" in text
    assert LINK_PATTERN.search(text) is not None


def test_invitation_without_template_still_creates_the_employee(
    client: TestClient, db_session: Session, caplog: pytest.LogCaptureFixture
) -> None:
    """Шаблона нет: письмо не уходит, но сотрудник и ссылка созданы."""
    owner_ready(client, db_session)

    with caplog.at_level(logging.ERROR):
        assert invite(client).status_code == 201

    assert FakeSMTP.sent == []
    assert INVITATION_TEMPLATE_CODE in caplog.text
    assert db_session.scalar(select(ActivationToken)) is not None


# --- 3. Активация по ссылке вводит приглашённого в организацию владельца -----


def test_activation_by_invitation_link_joins_the_owners_organization(
    client: TestClient, db_session: Session
) -> None:
    owner, organization = owner_ready(client, db_session)
    seed_invitation_template(db_session)
    assert invite(client).status_code == 201
    token = invitation_token(db_session)

    response = activate(client, token)

    assert response.status_code == 200, response.text
    assert response.json()["is_active"] is True

    db_session.expire_all()
    invited = invited_user(db_session)
    assert invited.is_active is True
    assert invited.active_organization_id == organization.id
    # Второй организации у приглашённого не появилось.
    assert count(db_session, Organization) == 1

    assert login(client, INVITEE_EMAIL, NEW_PASSWORD).status_code == 200
    view = client.get("/api/organization")
    assert view.status_code == 200, view.text
    assert view.json()["id"] == organization.id

    # Владелец видит приглашённого активированным.
    assert login(client, owner.email).status_code == 200
    members = client.get("/api/organization/members")
    assert members.status_code == 200, members.text
    invited_row = next(row for row in members.json() if row["email"] == INVITEE_EMAIL)
    assert invited_row["is_active"] is True
    assert invited_row["role"] == "commandant"


def test_second_visit_to_the_same_invitation_link_returns_410(
    client: TestClient, db_session: Session
) -> None:
    owner_ready(client, db_session)
    seed_invitation_template(db_session)
    assert invite(client).status_code == 201
    token = invitation_token(db_session)
    assert activate(client, token).status_code == 200

    again = activate(client, token, password="another-password-1")

    assert again.status_code == 410
    assert again.json()["detail"] == "Ссылка активации уже использована"


# --- 4. Занятый email, запрещённые роли, валидация ---------------------------


def test_invitation_to_an_existing_email_conflicts(client: TestClient, db_session: Session) -> None:
    owner_ready(client, db_session)
    create_user(db_session, email=INVITEE_EMAIL)
    before = (
        count(db_session, Organization),
        count(db_session, OrganizationMember),
        count(db_session, ActivationToken),
    )

    response = invite(client)

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "Пользователь с таким email уже зарегистрирован"
    assert FakeSMTP.sent == []
    assert (
        count(db_session, Organization),
        count(db_session, OrganizationMember),
        count(db_session, ActivationToken),
    ) == before


def test_owner_and_member_roles_are_rejected(client: TestClient, db_session: Session) -> None:
    owner_ready(client, db_session)

    for role in ("owner", "member"):
        response = invite(client, role=role)
        assert response.status_code == 422, f"{role}: {response.text}"

    assert FakeSMTP.sent == []
    assert db_session.scalar(select(User).where(User.email == INVITEE_EMAIL)) is None


def test_invitation_requires_an_email_and_a_full_name(
    client: TestClient, db_session: Session
) -> None:
    owner_ready(client, db_session)

    assert invite(client, email="не-почта").status_code == 422
    assert invite(client, full_name="   ").status_code == 422

    assert db_session.scalar(select(User).where(User.email == INVITEE_EMAIL)) is None


def test_invitation_rejects_an_unknown_field(client: TestClient, db_session: Session) -> None:
    owner_ready(client, db_session)

    response = client.post(
        "/api/organization/invitations",
        json={
            "email": INVITEE_EMAIL,
            "full_name": INVITEE_NAME,
            "role": "manager",
            "is_active": True,
        },
    )

    assert response.status_code == 422


def test_invitation_without_a_session_returns_401(client: TestClient) -> None:
    assert invite(client).status_code == 401
    assert client.get("/api/organization/members").status_code == 401


# --- 5. Список участников ----------------------------------------------------


def test_members_list_shows_the_owner_and_the_invited_employee(
    client: TestClient, db_session: Session
) -> None:
    owner, _ = owner_ready(client, db_session)
    assert invite(client, role="manager").status_code == 201

    response = client.get("/api/organization/members")

    assert response.status_code == 200, response.text
    members = response.json()
    assert len(members) == 2

    owner_row = next(row for row in members if row["email"] == owner.email)
    assert owner_row["role"] == "owner"
    assert owner_row["is_active"] is True
    assert owner_row["full_name"] == owner.full_name

    invited_row = next(row for row in members if row["email"] == INVITEE_EMAIL)
    assert invited_row["role"] == "manager"
    assert invited_row["is_active"] is False
    assert invited_row["full_name"] == INVITEE_NAME


def test_members_of_another_organization_are_not_shown(
    client: TestClient, db_session: Session
) -> None:
    owner, _ = owner_ready(client, db_session)
    stranger = create_user(db_session, email="stranger@example.com")
    organizations_for(db_session, stranger, name="ООО Чужая")

    response = client.get("/api/organization/members")

    assert response.status_code == 200, response.text
    emails = {row["email"] for row in response.json()}
    assert emails == {owner.email}


def test_members_endpoint_requires_a_link_to_an_organization(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="lonely@example.com")
    assert login(client, user.email).status_code == 200

    assert client.get("/api/organization/members").status_code == 404
    assert invite(client).status_code == 404


def test_inactive_invitee_gets_403_on_the_members_endpoints(
    client: TestClient, db_session: Session
) -> None:
    """Приглашённый до активации — неактивный пользователь: рабочие ручки закрыты."""
    owner_ready(client, db_session)
    assert invite(client).status_code == 201
    invited = invited_user(db_session)

    # Пароль приглашённого служебный и тесту неизвестен, поэтому сессию ставим
    # токеном напрямую — ровно так же, как это сделал бы вход.
    settings = get_settings()
    client.cookies.set(settings.session_cookie_name, create_access_token(str(invited.id)))

    members = client.get("/api/organization/members")
    send = invite(client, email="vtoroy@example.com")

    assert members.status_code == 403, members.text
    assert send.status_code == 403, send.text
    assert members.json()["detail"] == "Активируйте личный кабинет"
