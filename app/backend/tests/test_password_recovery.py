"""Восстановление пароля: письмо со ссылкой и лимит три отправки в час.

Тесты герметичны: фоновые задачи отправки подменяются записью, настоящий SMTP
не участвует, база — SQLite в памяти из `conftest`.
"""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api import activation as activation_api
from app.api import recovery as recovery_api
from app.api.recovery import (
    RECOVERY_DETAIL,
    try_consume_request,
)
from app.mail import RECOVERY_MAX_REQUESTS_PER_HOUR, RECOVERY_WINDOW_MINUTES
from app.models.activation import ActivationToken
from app.models.recovery_request import RecoveryRequest
from app.models.user import User
from app.security import issue_activation_token
from tests.conftest import create_user

RECOVERY_PATH = "/api/auth/password-recovery"
RESEND_PATH = "/api/auth/activate/resend"
NEW_PASSWORD = "recovered-password-123"


class MailLog:
    """Подмена фоновых задач: тест видит, какое письмо и на какой адрес ушло."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, str]] = []

    def activation(self, *, to: str, full_name: str, token: str) -> None:
        self.sent.append(("activation", to, token))

    def recovery(self, *, to: str, full_name: str, token: str) -> None:
        self.sent.append(("recovery", to, token))

    @property
    def kinds(self) -> list[str]:
        return [kind for kind, _, _ in self.sent]

    @property
    def last_token(self) -> str:
        return self.sent[-1][2]


@pytest.fixture
def mail(monkeypatch: pytest.MonkeyPatch) -> MailLog:
    """Письма не отправляются: задачи складываются в журнал теста.

    Обе задачи — и активации, и восстановления — пишут в один журнал: так тест
    видит, какое именно письмо ушло с ручки восстановления.
    """
    log = MailLog()
    monkeypatch.setattr(activation_api, "send_activation_email_task", log.activation)
    monkeypatch.setattr(recovery_api, "send_password_recovery_email_task", log.recovery)
    return log


def recovery_requests(db_session: Session) -> list[RecoveryRequest]:
    return list(db_session.scalars(select(RecoveryRequest)))


def tokens_of(db_session: Session, user: User) -> list[ActivationToken]:
    db_session.expire_all()
    return list(
        db_session.scalars(select(ActivationToken).where(ActivationToken.user_id == user.id))
    )


def live_tokens(db_session: Session, user: User) -> list[ActivationToken]:
    return [token for token in tokens_of(db_session, user) if token.used_at is None]


def test_recovery_for_active_user_sends_recovery_email_and_issues_token(
    client: TestClient, db_session: Session, mail: MailLog
) -> None:
    user = create_user(db_session, email="active@example.com")
    old_token = issue_activation_token(db_session, user.id)
    db_session.commit()

    response = client.post(RECOVERY_PATH, json={"email": user.email})

    assert response.status_code == 200
    assert response.json() == {"detail": RECOVERY_DETAIL}
    assert mail.kinds == ["recovery"]
    assert mail.sent[0][1] == user.email

    (issued,) = live_tokens(db_session, user)
    assert issued.kind == "recovery"
    # Прежняя живая ссылка погашена, новая — рабочая.
    assert client.get(f"/api/auth/activate/{old_token}").status_code == 410
    assert client.get(f"/api/auth/activate/{mail.last_token}").status_code == 200


@pytest.mark.parametrize("is_active", [True, False])
def test_recovery_sends_the_recovery_letter_for_both_cabinet_states(
    client: TestClient, db_session: Session, mail: MailLog, is_active: bool
) -> None:
    """С экрана «Забыли пароль?» всегда уходит письмо восстановления.

    Письмо активации с этого адреса не уходит даже неактивированному кабинету:
    его шлёт только `POST /auth/activate/resend`.
    """
    user = create_user(db_session, email="worker@example.com", is_active=is_active)

    response = client.post(RECOVERY_PATH, json={"email": user.email})

    assert response.status_code == 200
    assert response.json() == {"detail": RECOVERY_DETAIL}
    assert mail.kinds == ["recovery"]
    assert "activation" not in mail.kinds
    (issued,) = live_tokens(db_session, user)
    assert issued.kind == "recovery"


def test_recovery_link_activates_an_inactive_cabinet(
    client: TestClient, db_session: Session, mail: MailLog
) -> None:
    """Ссылка из письма восстановления активирует ещё не открытый кабинет."""
    user = create_user(db_session, email="inactive@example.com", is_active=False)

    client.post(RECOVERY_PATH, json={"email": user.email})
    token = mail.last_token

    assert client.get(f"/api/auth/activate/{token}").status_code == 200
    activated = client.post("/api/auth/activate", json={"token": token, "password": NEW_PASSWORD})
    assert activated.status_code == 200
    assert activated.json()["is_active"] is True
    assert client.get(f"/api/auth/activate/{token}").status_code == 410


def test_recovery_for_unknown_email_writes_nothing(
    client: TestClient, db_session: Session, mail: MailLog
) -> None:
    response = client.post(RECOVERY_PATH, json={"email": "nobody@example.com"})

    assert response.status_code == 200
    assert response.json() == {"detail": RECOVERY_DETAIL}
    assert mail.sent == []
    assert recovery_requests(db_session) == []
    assert list(db_session.scalars(select(ActivationToken))) == []


def test_recovery_answer_is_the_same_for_known_and_unknown_email(
    client: TestClient, db_session: Session, mail: MailLog
) -> None:
    user = create_user(db_session, email="known@example.com")

    known = client.post(RECOVERY_PATH, json={"email": user.email})
    unknown = client.post(RECOVERY_PATH, json={"email": "nobody@example.com"})

    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()


def test_limit_allows_three_requests_per_hour(
    client: TestClient, db_session: Session, mail: MailLog
) -> None:
    user = create_user(db_session, email="active@example.com")

    responses = [client.post(RECOVERY_PATH, json={"email": user.email}) for _ in range(4)]

    assert [response.status_code for response in responses] == [200, 200, 200, 200]
    assert {response.json()["detail"] for response in responses} == {RECOVERY_DETAIL}
    assert len(mail.sent) == RECOVERY_MAX_REQUESTS_PER_HOUR
    assert len(recovery_requests(db_session)) == RECOVERY_MAX_REQUESTS_PER_HOUR
    assert len(tokens_of(db_session, user)) == RECOVERY_MAX_REQUESTS_PER_HOUR


def test_limit_is_shared_by_resend_and_recovery(
    client: TestClient, db_session: Session, mail: MailLog
) -> None:
    """Чередованием двух ручек лимит не обойти: счётчик у них общий."""
    user = create_user(db_session, email="inactive@example.com", is_active=False)

    for _ in range(RECOVERY_MAX_REQUESTS_PER_HOUR):
        assert client.post(RESEND_PATH, json={"email": user.email}).status_code == 200

    fourth = client.post(RECOVERY_PATH, json={"email": user.email})

    assert fourth.status_code == 200
    assert fourth.json() == {"detail": RECOVERY_DETAIL}
    assert len(mail.sent) == RECOVERY_MAX_REQUESTS_PER_HOUR
    assert len(recovery_requests(db_session)) == RECOVERY_MAX_REQUESTS_PER_HOUR


def test_email_case_is_the_same_address(
    client: TestClient, db_session: Session, mail: MailLog
) -> None:
    user = create_user(db_session, email="worker@example.com")

    for _ in range(RECOVERY_MAX_REQUESTS_PER_HOUR):
        client.post(RECOVERY_PATH, json={"email": "Worker@Example.COM"})
    client.post(RECOVERY_PATH, json={"email": user.email})

    assert len(mail.sent) == RECOVERY_MAX_REQUESTS_PER_HOUR
    assert len(recovery_requests(db_session)) == RECOVERY_MAX_REQUESTS_PER_HOUR


def test_link_issued_before_the_limit_still_works(
    client: TestClient, db_session: Session, mail: MailLog
) -> None:
    user = create_user(db_session, email="active@example.com")

    for _ in range(RECOVERY_MAX_REQUESTS_PER_HOUR + 1):
        client.post(RECOVERY_PATH, json={"email": user.email})

    assert len(mail.sent) == RECOVERY_MAX_REQUESTS_PER_HOUR
    token = mail.last_token

    assert client.get(f"/api/auth/activate/{token}").status_code == 200
    activated = client.post("/api/auth/activate", json={"token": token, "password": NEW_PASSWORD})
    assert activated.status_code == 200
    assert activated.json()["is_active"] is True
    assert client.get(f"/api/auth/activate/{token}").status_code == 410


def test_window_opens_again_after_an_hour(db_session: Session) -> None:
    email = "worker@example.com"
    for _ in range(RECOVERY_MAX_REQUESTS_PER_HOUR):
        assert try_consume_request(db_session, email) is True
    assert try_consume_request(db_session, email) is False

    # Прежние отметки уезжают за окно: место снова свободно, старые строки вычищаются.
    long_ago = datetime.now(UTC) - timedelta(minutes=RECOVERY_WINDOW_MINUTES + 1)
    db_session.execute(update(RecoveryRequest).values(created_at=long_ago))
    db_session.commit()

    assert try_consume_request(db_session, email) is True
    assert len(recovery_requests(db_session)) == 1
