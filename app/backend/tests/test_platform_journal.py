"""Платформенный журнал: `GET /api/platform/journal` за сервисным токеном.

Контракт: лента по всем организациям за период, строка `organization_id IS NULL`
присутствует с `organization_name = null`, отказы периода и курсора - те же тексты,
что у клиентского журнала, страницы по keyset не повторяют и не теряют строки.
"""

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app import audit as audit_rules
from app.config import get_settings
from app.journal import (
    INVALID_CURSOR_DETAIL,
    RANGE_IN_FUTURE_DETAIL,
    RANGE_INVERTED_DETAIL,
    RANGE_TOO_LONG_DETAIL,
)
from app.models.audit import AuditEvent
from app.models.organization import Organization
from app.report_readiness import today_moscow
from app.security import INVALID_OPERATOR_TOKEN_DETAIL

# Заведомо ненастоящий секрет: настоящий в тестах не нужен.
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}
WRONG_HEADERS = {"X-Operator-Token": "not-the-token"}
JOURNAL = "/api/platform/journal"

# Поля строки по контракту: клиентская запись плюс организация. Сверка набором.
PLATFORM_ENTRY_FIELDS = {
    "id",
    "created_at",
    "actor_id",
    "actor_name",
    "method",
    "path",
    "action",
    "action_title",
    "kind",
    "status",
    "duration_ms",
    "ip",
    "user_agent",
    "request_id",
    "path_params",
    "request_body",
    "changes",
    "organization_id",
    "organization_name",
}


@pytest.fixture
def operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный секрет сервисного контура; кеш настроек сбрасывается до и после."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


def organization(db_session: Session, name: str, inn: str) -> Organization:
    """Организация для ленты: название и ИНН нужны только для проверки имени в ответе."""
    row = Organization(name=name, inn=inn, created_at=datetime(2026, 1, 1, tzinfo=UTC))
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def add_event(
    db_session: Session,
    *,
    organization_id: int | None,
    created_at: datetime | None = None,
    kind: str = audit_rules.KIND_DATA,
    action: str = "patch_dormitories",
) -> AuditEvent:
    """Строка журнала напрямую в базе: настоящей ручкой строку платформы не создать."""
    event = AuditEvent(
        created_at=created_at if created_at is not None else datetime.now(UTC),
        organization_id=organization_id,
        method="PATCH",
        path="/api/dormitories/{dormitory_id}",
        action=action,
        kind=kind,
        status=200,
        duration_ms=5,
    )
    db_session.add(event)
    db_session.commit()
    db_session.refresh(event)
    return event


def get_journal(client: TestClient, headers: dict[str, str] | None = None, **params: Any) -> Any:
    return client.get(
        JOURNAL, params=params, headers=OPERATOR_HEADERS if headers is None else headers
    )


def test_requires_the_service_token(client: TestClient, operator_token: None) -> None:
    """Без токена и с чужим токеном - `401`; тексты отказа - как у соседних platform_*."""
    missing = client.get(JOURNAL)
    wrong = get_journal(client, headers=WRONG_HEADERS)

    assert missing.status_code == 401
    assert missing.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}
    assert wrong.status_code == 401
    assert wrong.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


def test_feed_spans_all_organizations_with_names(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Лента по всем организациям: у каждой строки своё название, форма - по контракту."""
    first = organization(db_session, "Северное", "7701000001")
    second = organization(db_session, "Южное", "7701000002")
    add_event(db_session, organization_id=first.id)
    add_event(db_session, organization_id=second.id)

    response = get_journal(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"items", "next_cursor", "total"}
    assert body["total"] == 2
    assert body["next_cursor"] is None
    assert {item["organization_id"] for item in body["items"]} == {first.id, second.id}
    names = {item["organization_id"]: item["organization_name"] for item in body["items"]}
    assert names == {first.id: "Северное", second.id: "Южное"}
    for item in body["items"]:
        assert set(item) == PLATFORM_ENTRY_FIELDS


def test_platform_rows_are_kept_with_null_organization(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Строка `organization_id IS NULL` попадает в ленту с `organization_name = null`."""
    company = organization(db_session, "Северное", "7701000003")
    add_event(db_session, organization_id=company.id)
    platform_row = add_event(db_session, organization_id=None, action="post_login")

    response = get_journal(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 2
    platform = next(item for item in body["items"] if item["id"] == platform_row.id)
    assert platform["organization_id"] is None
    assert platform["organization_name"] is None


def test_kind_filter_applies_across_organizations(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Фильтр вида действует по всей ленте, а не по одной организации."""
    first = organization(db_session, "Северное", "7701000004")
    second = organization(db_session, "Южное", "7701000005")
    add_event(db_session, organization_id=first.id, kind=audit_rules.KIND_SECURITY)
    add_event(db_session, organization_id=second.id, kind=audit_rules.KIND_DATA)
    add_event(db_session, organization_id=None, kind=audit_rules.KIND_NOISE)

    response = get_journal(client, kind=audit_rules.KIND_SECURITY)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 1
    assert [item["organization_id"] for item in body["items"]] == [first.id]


def test_period_outside_rules_is_422_with_server_text(
    client: TestClient, operator_token: None
) -> None:
    """Отказы периода - ровно тексты сервера, без приставок и без точки в конце."""
    today = today_moscow()

    too_long = get_journal(
        client, date_from=(today - timedelta(days=120)).isoformat(), date_to=today.isoformat()
    )
    inverted = get_journal(
        client, date_from=today.isoformat(), date_to=(today - timedelta(days=3)).isoformat()
    )
    future = get_journal(client, date_from=(today + timedelta(days=2)).isoformat())

    assert too_long.status_code == 422
    assert too_long.json() == {"detail": RANGE_TOO_LONG_DETAIL}
    assert inverted.status_code == 422
    assert inverted.json() == {"detail": RANGE_INVERTED_DETAIL}
    assert future.status_code == 422
    assert future.json() == {"detail": RANGE_IN_FUTURE_DETAIL}


def test_broken_cursor_and_bad_limit_are_422(client: TestClient, operator_token: None) -> None:
    """Непрозрачный курсор не из ленты и `limit` вне 1..200 - `422`."""
    broken = get_journal(client, cursor="not-a-cursor")
    too_big = get_journal(client, limit=201)

    assert broken.status_code == 422
    assert broken.json() == {"detail": INVALID_CURSOR_DETAIL}
    assert too_big.status_code == 422


def test_keyset_pages_do_not_repeat_or_lose_rows(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Страницы по курсору: без повторов, без потерь; `total` только на первой странице."""
    first = organization(db_session, "Северное", "7701000006")
    base = datetime.now(UTC) - timedelta(minutes=10)
    # Пять строк с одинаковым моментом: курсор должен различать их по `id`.
    created = [
        add_event(db_session, organization_id=first.id if n % 2 else None, created_at=base)
        for n in range(5)
    ]

    seen: list[int] = []
    cursor: str | None = None
    totals: list[int | None] = []
    for _ in range(10):
        page = (
            get_journal(client, limit=2, cursor=cursor) if cursor else get_journal(client, limit=2)
        )
        assert page.status_code == 200, page.text
        body = page.json()
        totals.append(body["total"])
        seen.extend(item["id"] for item in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert len(seen) == len(set(seen)) == len(created)
    assert set(seen) == {row.id for row in created}
    assert totals[0] == 5
    assert all(total is None for total in totals[1:])


def test_default_period_and_no_organization_filter(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Без параметров - последние 7 дней по московскому календарю; строки старше не попадают."""
    old = organization(db_session, "Архивное", "7701000007")
    add_event(db_session, organization_id=old.id, created_at=datetime.now(UTC) - timedelta(days=30))
    recent = add_event(db_session, organization_id=old.id)

    response = get_journal(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["id"] for item in body["items"]] == [recent.id]


def test_explicit_single_day_window(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Окно из одного дня по московскому календарю возвращает только свою строку."""
    company = organization(db_session, "Северное", "7701000008")
    day = date(2026, 3, 10)
    inside = add_event(
        db_session,
        organization_id=company.id,
        created_at=datetime(2026, 3, 10, 12, 0, tzinfo=UTC),
    )
    add_event(
        db_session,
        organization_id=company.id,
        created_at=datetime(2026, 3, 12, 12, 0, tzinfo=UTC),
    )

    response = get_journal(client, date_from=day.isoformat(), date_to=day.isoformat())

    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()["items"]] == [inside.id]
