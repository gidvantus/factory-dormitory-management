"""Журнал действий: ФИО автора снимком на момент записи (issue #75).

Проверяется ровно то, что обещает постановка:

* новая строка журнала хранит `actor_name`, равное `users.full_name` автора;
* переименование пользователя **не** переписывает уже записанные строки — ни в
  базе, ни в ответе `GET /api/journal` (join-а на `users` при чтении нет);
* у записей без сессии (вход, регистрация, восстановление пароля) имени нет:
  `actor_name IS NULL`;
* у строк, записанных до ревизии `0044_audit_actor_name`, значение тоже `NULL`,
  и ручка отдаёт `actor_name: null`, а не падает.

Юнит-тесты идут на SQLite, где `audit_events` — обычная таблица без партиций;
сама миграция проверяется на стенде отдела, а не здесь.
"""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.models.audit import AuditEvent
from app.models.user import User
from tests.conftest import TEST_PASSWORD, create_user, organizations_for, sign_in

DORMITORY_PAYLOAD = {"name": "Северное", "client_name": "Стройкомплект"}

ACTOR_NAME = "Иванов Иван Иванович"
RENAMED = "Петрова Мария Сергеевна"

# Строка до ревизии `0044_audit_actor_name` — записана без имени автора.
OLD_ACTION = "patch_dormitories"
OLD_ACTOR_NAME = "Сидоров Пётр Петрович"

# Роль `owner` в приглашении — отказ 422 от схемы: настоящий неудачный
# write-запрос, который middleware записывает после ответа (best-effort путь).
INVITATION_PAYLOAD = {"email": "employee@example.com", "full_name": "Петров Пётр", "role": "owner"}


def events(db_session: Session) -> list[AuditEvent]:
    """Строки журнала в порядке появления."""
    db_session.expire_all()
    return list(db_session.scalars(select(AuditEvent).order_by(AuditEvent.id)))


def last_event(db_session: Session) -> AuditEvent:
    """Последняя строка журнала."""
    return events(db_session)[-1]


def journal_items(client: TestClient) -> list[dict[str, Any]]:
    """Записи журнала по контракту `GET /api/journal`."""
    response = client.get("/api/journal")
    assert response.status_code == 200, response.text
    body = response.json()
    items = body["items"]
    assert isinstance(items, list)
    return items


def rename_user(db_session: Session, user: User, full_name: str) -> None:
    """Переименовать пользователя в базе — так же, как это сделала бы ручка."""
    user.full_name = full_name
    db_session.commit()


def test_action_row_stores_the_actor_name(client: TestClient, db_session: Session) -> None:
    """Атомарная строка (коммит самого действия) хранит ФИО из `users.full_name`."""
    user = sign_in(client, db_session)

    created = client.post("/api/dormitories", json=DORMITORY_PAYLOAD)
    assert created.status_code == 201, created.text

    row = last_event(db_session)
    assert row.action == "post_dormitories"
    assert row.actor_id == user.id
    # ФИО — копия, а не ссылка: строка отвечает на вопрос «кто действовал».
    assert row.actor_name == ACTOR_NAME


def test_refused_request_after_response_stores_the_actor_name(
    client: TestClient, db_session: Session
) -> None:
    """Best-effort строка (после ответа) тоже получает имя: актор уже известен."""
    sign_in(client, db_session)

    refused = client.post("/api/organization/invitations", json=INVITATION_PAYLOAD)
    assert refused.status_code == 422, refused.text

    row = last_event(db_session)
    assert row.action == "post_organization_invitations"
    assert row.status == 422
    assert row.actor_id is not None
    assert row.actor_name == ACTOR_NAME


def test_row_without_session_has_no_actor_name(client: TestClient, db_session: Session) -> None:
    """Вход идёт до появления сессии: ни актора, ни имени в строке нет."""
    create_user(db_session)

    response = client.post(
        "/api/auth/login",
        json={"email": "worker@example.com", "password": TEST_PASSWORD},
    )
    assert response.status_code == 200, response.text

    row = last_event(db_session)
    assert row.action == "post_auth_login"
    assert row.actor_id is None
    assert row.actor_name is None


def test_renaming_a_user_does_not_rewrite_the_stored_row(
    client: TestClient, db_session: Session
) -> None:
    """Смена фамилии не переписывает историю задним числом — ни в базе, ни в API."""
    user = sign_in(client, db_session)
    created = client.post("/api/dormitories", json=DORMITORY_PAYLOAD)
    assert created.status_code == 201, created.text
    assert last_event(db_session).actor_name == ACTOR_NAME

    rename_user(db_session, user, RENAMED)

    # В самой строке осталось имя на момент записи.
    assert last_event(db_session).actor_name == ACTOR_NAME
    # И ручка отдаёт то, что записано, а не текущее значение `users.full_name`.
    written = next(item for item in journal_items(client) if item["action"] == "post_dormitories")
    assert written["actor_id"] == user.id
    assert written["actor_name"] == ACTOR_NAME
    assert written["actor_name"] != user.full_name

    # Новое действие записывается уже с новым именем: снимок берётся на момент
    # записи, а не один раз при создании пользователя.
    updated = client.patch(f"/api/dormitories/{created.json()['id']}", json={"is_archived": True})
    assert updated.status_code == 200, updated.text
    assert last_event(db_session).actor_name == RENAMED


def test_stored_name_wins_over_the_current_one_at_read_time(
    client: TestClient, db_session: Session
) -> None:
    """Ответ строится только по строке журнала: join-а на `users` нет.

    Строка подготовлена прямо в базе с именем, которое не совпадает с текущим
    `full_name` автора. Если бы чтение подставляло имя из `users`, вернулось бы
    текущее — и смена фамилии переписала бы уже собранный журнал.
    """
    user = create_user(db_session)
    organization, _member = organizations_for(db_session, user)
    user.full_name = ACTOR_NAME
    db_session.commit()
    db_session.add(
        AuditEvent(
            organization_id=organization.id,
            actor_id=user.id,
            actor_name=OLD_ACTOR_NAME,
            method="PATCH",
            path="/api/dormitories/{dormitory_id}",
            action=OLD_ACTION,
            kind=audit.KIND_DATA,
        )
    )
    db_session.commit()

    response = client.post(
        "/api/auth/login",
        json={"email": user.email, "password": TEST_PASSWORD},
    )
    assert response.status_code == 200, response.text

    written = next(item for item in journal_items(client) if item["action"] == OLD_ACTION)
    assert written["actor_name"] == OLD_ACTOR_NAME
    # Значение из `users` осталось своим и в ответ не попало.
    assert user.full_name == ACTOR_NAME
    assert written["actor_name"] != user.full_name


def test_rows_without_a_name_are_returned_as_null(client: TestClient, db_session: Session) -> None:
    """Строки до ревизии `0044` отдаются с `actor_name: null`, ручка не падает."""
    user = sign_in(client, db_session)
    organization_id = user.active_organization_id
    assert organization_id is not None
    # Строка «старого» журнала: имя не записано, потому что колонки тогда не было.
    db_session.add(
        AuditEvent(
            organization_id=organization_id,
            actor_id=user.id,
            method="PATCH",
            path="/api/dormitories/{dormitory_id}",
            action=OLD_ACTION,
            kind=audit.KIND_DATA,
        )
    )
    db_session.commit()

    created = client.post("/api/dormitories", json=DORMITORY_PAYLOAD)
    assert created.status_code == 201, created.text

    items = journal_items(client)
    old_entry = next(item for item in items if item["action"] == OLD_ACTION)
    assert old_entry["actor_id"] == user.id
    assert old_entry["actor_name"] is None

    new_entry = next(item for item in items if item["action"] == "post_dormitories")
    assert new_entry["actor_name"] == ACTOR_NAME


def test_record_actor_puts_the_name_into_row_values() -> None:
    """`record_actor` дописывает имя в контекст, `values()` кладёт его в строку."""
    context = audit.AuditContext(
        request_id="unit-test",
        method="POST",
        scope={},
        ip=None,
        user_agent=None,
        request_body=None,
        started=0.0,
    )
    token = audit.start_context(context)
    try:
        # По умолчанию имени нет: у запроса без сессии автора тоже нет.
        assert context.values(status=None, duration_ms=None)["actor_name"] is None
        audit.record_actor(actor_id=7, organization_id=3, actor_name=ACTOR_NAME)
        values = context.values(status=None, duration_ms=None)
    finally:
        audit.finish_context(token)

    assert values["actor_id"] == 7
    assert values["organization_id"] == 3
    assert values["actor_name"] == ACTOR_NAME
