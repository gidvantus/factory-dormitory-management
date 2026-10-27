"""Чтение журнала действий: `GET /api/journal` (issue #74, гейт — #95).

Журнал — платное решение каталога магазина улучшений (`journal`, 300 ₽ в месяц),
поэтому читает его только владелец организации **с действующим правом**: без права
ручка отвечает 403 с текстом про магазин, и это контракт с кабинетом. Владельцы в
остальных сценариях получают право в общем помощнике (`owner_with_organization`),
как после оплаты счёта.

Юнит-тесты идут на SQLite, где `audit_events` — обычная таблица без партиций.
Проверяется ровно то, что обещает постановка: кто имеет право читать, что
отдаётся и чего в ответе быть не должно, как работают фильтры и постраничный
курсор и что чтение не оставляет собственных строк в журнале.

Календарь фильтра — московский (`Europe/Moscow`), как и в остальных разделах
кабинета: отдельный тест проверяет, что запись в 01:30 МСК попадает в свой
московский день, а не в предыдущие UTC-сутки. Из-за этого даты в тестах берутся
из `today_moscow()`, а не из `datetime.now(UTC).date()`.

Строки журнала здесь двух видов. Настоящие — их пишет middleware на write-запросы
(создание общежития, отказ приглашения); на них проверяется форма ответа, включая
пустые `status`/`duration_ms` у атомарной строки. Подготовленные прямо в базе —
когда нужен точный момент времени, равные `created_at`, чужая организация или
незнакомый код действия.

Вход тоже оставляет строку журнала, но без организации: сессии на момент входа
ещё нет. Это и есть тот случай `organization_id IS NULL`, которого в ответе быть
не должно.
"""

from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit as audit_rules
from app.api.organization import (
    ORGANIZATION_EDIT_FORBIDDEN_DETAIL,
    ORGANIZATION_NOT_FOUND_DETAIL,
)
from app.models.audit import AuditEvent
from app.models.organization import Organization
from app.report_readiness import today_moscow
from app.security import ACTIVATION_REQUIRED_DETAIL
from app.solutions import SOLUTION_REQUIRED_DETAIL
from tests.conftest import (
    JOURNAL_CODE,
    TELEGRAM_NOTIFICATIONS_CODE,
    create_user,
    give_solution,
    login,
    organizations_for,
)

# Календарь, по которому считаются сутки периода (см. `app/api/audit.py`).
MOSCOW = ZoneInfo("Europe/Moscow")

# Поля записи по контракту. Ответ не должен ни терять их, ни добавлять лишние:
# фронт читает ровно эти имена.
ENTRY_FIELDS = {
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
}

DORMITORY_PAYLOAD = {"name": "Северное", "client_name": "Стройкомплект"}

# Роль `owner` в приглашении — отказ 422 от схемы: подходит как настоящий
# неудачный write-запрос, который middleware записывает после ответа.
INVITATION_PAYLOAD = {"email": "employee@example.com", "full_name": "Петров Пётр", "role": "owner"}


def journal(client: TestClient, **params: Any) -> Any:
    """Запрос к ручке журнала с произвольными параметрами фильтра."""
    return client.get("/api/journal", params=params)


def owner_with_organization(
    client: TestClient,
    db_session: Session,
    *,
    email: str = "owner@example.com",
    role: str = "owner",
    with_journal: bool = True,
) -> tuple[int, Organization]:
    """Пользователь с организацией и открытой сессией.

    Возвращает идентификатор пользователя и организацию. Вход оставляет в
    журнале строку без организации — она в ответе появиться не должна.

    Журнал — платное решение каталога (`journal`), поэтому владелец получает право
    так же, как после оплаты счёта: без права ручка закрыта, и почти все сценарии
    ниже проверяют чтение, а не гейт. `with_journal=False` оставляет организацию
    без права — это отдельные тесты отказа.
    """
    user = create_user(db_session, email=email)
    organization, _member = organizations_for(db_session, user, role=role)
    if with_journal:
        # Право выдаётся и роли не владельца: тогда сценарий отказа по роли
        # доказывает, что проверка роли идёт раньше проверки права.
        give_solution(db_session, organization, code=JOURNAL_CODE)
    assert login(client, user.email).status_code == 200
    return user.id, organization


def add_event(
    db_session: Session,
    *,
    organization_id: int | None,
    created_at: datetime | None = None,
    kind: str = audit_rules.KIND_DATA,
    action: str = "patch_dormitories",
    method: str = "PATCH",
    path: str = "/api/dormitories/{dormitory_id}",
    status: int | None = None,
    duration_ms: int | None = None,
    request_body: Any | None = None,
    changes: list[dict[str, Any]] | None = None,
) -> AuditEvent:
    """Положить строку журнала в базу напрямую.

    Нужно там, где настоящей ручкой строку не создать: чужая организация,
    `organization_id = NULL`, точный момент времени, незнакомый код действия.
    """
    event = AuditEvent(
        created_at=created_at if created_at is not None else datetime.now(UTC),
        organization_id=organization_id,
        method=method,
        path=path,
        action=action,
        kind=kind,
        status=status,
        duration_ms=duration_ms,
        request_body=request_body,
        changes=changes,
    )
    db_session.add(event)
    db_session.commit()
    db_session.refresh(event)
    return event


def organization_event_ids(db_session: Session, organization_id: int) -> list[int]:
    """Все строки организации в порядке ленты: свежие сверху, при равенстве — по id."""
    db_session.expire_all()
    return list(
        db_session.scalars(
            select(AuditEvent.id)
            .where(AuditEvent.organization_id == organization_id)
            .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        )
    )


def test_owner_reads_actions_of_own_organization(client: TestClient, db_session: Session) -> None:
    """Владелец видит действия организации, форма записи — по контракту."""
    user_id, _organization = owner_with_organization(client, db_session)

    created = client.post("/api/dormitories", json=DORMITORY_PAYLOAD)
    assert created.status_code == 201, created.text
    refused = client.post("/api/organization/invitations", json=INVITATION_PAYLOAD)
    assert refused.status_code == 422, refused.text

    response = journal(client)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"items", "next_cursor", "total"}
    # Записей мало: следующей страницы нет.
    assert body["next_cursor"] is None
    # `total` — число записей за период во всей ленте, а не на странице.
    assert body["total"] == 2
    actions = sorted(item["action"] for item in body["items"])
    assert actions == ["post_dormitories", "post_organization_invitations"]
    # Вход прошёл в этом же тесте, но у его строки организации нет.
    assert "post_auth_login" not in actions

    created_entry = next(item for item in body["items"] if item["action"] == "post_dormitories")
    assert set(created_entry) == ENTRY_FIELDS
    assert created_entry["action_title"] == audit_rules.action_title("post_dormitories")
    assert created_entry["kind"] == audit_rules.KIND_DATA
    assert created_entry["method"] == "POST"
    assert created_entry["path"] == "/api/dormitories"
    assert created_entry["actor_id"] == user_id
    assert created_entry["request_id"] is not None
    # Время с таймзоной: клиент не должен достраивать его до местного сам.
    # UTC сериализатор пишет как `Z`, а не как наивную строку.
    assert created_entry["created_at"].endswith(("Z", "+00:00"))
    # Строка ушла коммитом самого действия: код ответа и длительность неизвестны.
    assert created_entry["status"] is None
    assert created_entry["duration_ms"] is None

    # Отказ ручки записан после ответа: у него есть и код, и длительность.
    refused_entry = next(
        item for item in body["items"] if item["action"] == "post_organization_invitations"
    )
    assert refused_entry["status"] == 422
    assert refused_entry["duration_ms"] is not None
    # Раздел организации — действие безопасности, вид считается при записи.
    assert refused_entry["kind"] == audit_rules.KIND_SECURITY


@pytest.mark.parametrize("role", ["admin", "manager", "commandant", "member"])
def test_other_organization_roles_are_forbidden(
    client: TestClient, db_session: Session, role: str
) -> None:
    """Ни одна роль, кроме владельца, журнал не читает — `admin` в том числе.

    Право на решение `journal` у организации при этом есть (его выдаёт помощник):
    отказ по роли обязан прийти раньше отказа по праву, иначе сотрудник увидел бы
    предложение купить то, чего ему не откроют.
    """
    owner_with_organization(client, db_session, email=f"{role}@example.com", role=role)

    response = journal(client)

    assert response.status_code == 403
    assert response.json()["detail"] == ORGANIZATION_EDIT_FORBIDDEN_DETAIL


def test_journal_openapi_documents_all_three_refusals(client: TestClient) -> None:
    """403 у ручки описан тремя текстами: активация, роль, решение.

    Открытая схема — контракт с кабинетом: пропавший третий текст означал бы, что
    гейт права перестал быть частью контракта.
    """
    schema = client.get("/openapi.json").json()
    description = schema["paths"]["/api/journal"]["get"]["responses"]["403"]["description"]

    assert ACTIVATION_REQUIRED_DETAIL in description
    assert ORGANIZATION_EDIT_FORBIDDEN_DETAIL in description
    assert SOLUTION_REQUIRED_DETAIL in description


def test_owner_without_the_solution_gets_the_shop_refusal(
    client: TestClient, db_session: Session
) -> None:
    """Владелец без права на решение `journal`: 403, и текст дословно контрактный.

    Экран выбирает состояние по роли и праву, но гонку («право истекло после
    загрузки каталога») закрывает именно этот ответ, поэтому `detail` сверяется
    дословно, а не по смыслу.
    """
    owner_with_organization(client, db_session, with_journal=False)

    response = journal(client)

    assert response.status_code == 403
    assert response.json()["detail"] == SOLUTION_REQUIRED_DETAIL


def test_expired_solution_closes_the_journal(client: TestClient, db_session: Session) -> None:
    """Просроченное право — не право: подменить часы тест не может, поэтому срок в прошлом."""
    _owner_id, organization = owner_with_organization(client, db_session, with_journal=False)
    give_solution(
        db_session,
        organization,
        code=JOURNAL_CODE,
        expires_at=datetime.now(UTC) - timedelta(minutes=1),
    )

    response = journal(client)

    assert response.status_code == 403
    assert response.json()["detail"] == SOLUTION_REQUIRED_DETAIL


def test_owner_with_the_solution_reads_the_journal(client: TestClient, db_session: Session) -> None:
    """Право на журнал открывает ленту: 200 и записи своей организации."""
    _owner_id, organization = owner_with_organization(client, db_session)
    add_event(db_session, organization_id=organization.id, action="post_owned_dormitory")

    response = journal(client)

    assert response.status_code == 200, response.text
    assert [item["action"] for item in response.json()["items"]] == ["post_owned_dormitory"]


def test_right_to_another_solution_does_not_open_the_journal(
    client: TestClient, db_session: Session
) -> None:
    """Оплаченные «Уведомления» — не право на журнал: решения продаются отдельно."""
    _owner_id, organization = owner_with_organization(client, db_session, with_journal=False)
    give_solution(db_session, organization, code=TELEGRAM_NOTIFICATIONS_CODE)

    response = journal(client)

    assert response.status_code == 403
    assert response.json()["detail"] == SOLUTION_REQUIRED_DETAIL


def test_user_without_organization_gets_404(client: TestClient, db_session: Session) -> None:
    """Пользователь без организации: 404, а не пустой журнал и не 403."""
    user = create_user(db_session, email="noorg@example.com")
    assert login(client, user.email).status_code == 200

    response = journal(client)

    assert response.status_code == 404
    assert response.json()["detail"] == ORGANIZATION_NOT_FOUND_DETAIL


def test_inactive_cabinet_is_forbidden(client: TestClient, db_session: Session) -> None:
    """Неактивированный кабинет закрыт раньше проверки роли и права.

    Право на журнал у организации уже есть — и это доказывает порядок: ответ про
    активацию, а не про магазин, иначе человек вместо ссылки на письмо увидел бы
    предложение купить решение.
    """
    user = create_user(db_session, email="sleeping@example.com", is_active=False)
    organization, _member = organizations_for(db_session, user)
    give_solution(db_session, organization, code=JOURNAL_CODE)
    assert login(client, user.email).status_code == 200

    response = journal(client)

    assert response.status_code == 403
    assert response.json()["detail"] == ACTIVATION_REQUIRED_DETAIL


def test_foreign_organization_rows_are_never_returned(
    client: TestClient, db_session: Session
) -> None:
    """Строка чужой организации не попадает в ответ ни при каких фильтрах."""
    _owner_id, organization = owner_with_organization(client, db_session)
    # Чужая организация заводится прямо в базе: второй вход переключил бы cookie
    # клиента на другого пользователя, и проверка стала бы бессмысленной.
    foreign_user = create_user(db_session, email="foreign@example.com")
    foreign_organization, _member = organizations_for(db_session, foreign_user)
    add_event(
        db_session,
        organization_id=foreign_organization.id,
        action="post_foreign_dormitory",
        created_at=datetime.now(UTC),
    )
    add_event(
        db_session,
        organization_id=organization.id,
        action="post_own_dormitory",
        created_at=datetime.now(UTC),
    )

    response = journal(client)

    assert response.status_code == 200
    actions = [item["action"] for item in response.json()["items"]]
    assert actions == ["post_own_dormitory"]


def test_rows_without_organization_are_never_returned(
    client: TestClient, db_session: Session
) -> None:
    """Вход, регистрация и восстановление пароля — события платформы, не организации."""
    owner_with_organization(client, db_session)
    db_session.expire_all()
    organizationless = db_session.scalar(
        select(func.count()).select_from(AuditEvent).where(AuditEvent.organization_id.is_(None))
    )
    # Строка входа действительно есть — значит пустой ответ ниже не пустой тест.
    assert organizationless == 1

    response = journal(client)

    assert response.status_code == 200
    assert response.json()["items"] == []
    assert response.json()["next_cursor"] is None


def test_pagination_returns_every_row_once(client: TestClient, db_session: Session) -> None:
    """Две страницы по курсору: без дублей и пропусков, в том числе при равном моменте."""
    _owner_id, organization = owner_with_organization(client, db_session)
    same_moment = datetime.now(UTC) - timedelta(minutes=5)
    for _ in range(5):
        # Одинаковый `created_at` — именно тот случай, где `OFFSET` и сравнение
        # по одной колонке дают дубли или пропуски.
        add_event(db_session, organization_id=organization.id, created_at=same_moment)
    add_event(
        db_session,
        organization_id=organization.id,
        created_at=same_moment - timedelta(minutes=1),
    )

    expected = organization_event_ids(db_session, organization.id)
    assert len(expected) == 6

    collected: list[int] = []
    cursor: str | None = None
    for page in range(10):
        params: dict[str, Any] = {"limit": 2}
        if cursor is not None:
            params["cursor"] = cursor
        response = journal(client, **params)
        assert response.status_code == 200, response.text
        body = response.json()
        assert len(body["items"]) <= 2
        # Число записей за период отдаётся только с первой страницы: на
        # «Показать ещё» сервер не платит за `COUNT`.
        assert body["total"] == (len(expected) if page == 0 else None)
        collected.extend(item["id"] for item in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            break

    assert cursor is None
    assert collected == expected
    assert len(collected) == len(set(collected))


def test_last_page_returns_null_cursor(client: TestClient, db_session: Session) -> None:
    """Ровно `limit` строк — следующей страницы нет, лишний запрос не нужен."""
    _owner_id, organization = owner_with_organization(client, db_session)
    for _ in range(2):
        add_event(db_session, organization_id=organization.id)
    total = len(organization_event_ids(db_session, organization.id))
    assert total == 2

    response = journal(client, limit=total)

    assert response.status_code == 200
    assert response.json()["next_cursor"] is None
    assert response.json()["total"] == total
    assert len(response.json()["items"]) == total


def test_kind_filter(client: TestClient, db_session: Session) -> None:
    """Фильтр по виду: только выбранный вид, остальные отсекаются."""
    _owner_id, organization = owner_with_organization(client, db_session)
    add_event(
        db_session,
        organization_id=organization.id,
        kind=audit_rules.KIND_SECURITY,
        action="patch_organization",
        created_at=datetime.now(UTC),
    )
    add_event(
        db_session,
        organization_id=organization.id,
        kind=audit_rules.KIND_DATA,
        action="post_residents",
        created_at=datetime.now(UTC),
    )
    add_event(
        db_session,
        organization_id=organization.id,
        kind=audit_rules.KIND_NOISE,
        action="put_hostels_cells",
        created_at=datetime.now(UTC),
    )

    security = journal(client, kind=audit_rules.KIND_SECURITY)
    data = journal(client, kind=audit_rules.KIND_DATA)
    noise = journal(client, kind=audit_rules.KIND_NOISE)

    for response in (security, data, noise):
        assert response.status_code == 200
    assert [item["action"] for item in security.json()["items"]] == ["patch_organization"]
    assert [item["action"] for item in data.json()["items"]] == ["post_residents"]
    assert [item["action"] for item in noise.json()["items"]] == ["put_hostels_cells"]


def test_unknown_kind_is_rejected(client: TestClient, db_session: Session) -> None:
    owner_with_organization(client, db_session)

    response = journal(client, kind="everything")

    assert response.status_code == 422


def test_date_range_filter(client: TestClient, db_session: Session) -> None:
    """Период отсекает записи: и старые, и те, что позже конца периода."""
    _owner_id, organization = owner_with_organization(client, db_session)
    now = datetime.now(UTC)
    today = today_moscow()
    add_event(
        db_session,
        organization_id=organization.id,
        action="post_three_days_ago",
        created_at=now - timedelta(days=3),
    )
    add_event(
        db_session,
        organization_id=organization.id,
        action="post_long_ago",
        created_at=now - timedelta(days=40),
    )
    add_event(
        db_session,
        organization_id=organization.id,
        action="post_recent",
        created_at=now,
    )

    response = journal(
        client,
        date_from=(today - timedelta(days=1)).isoformat(),
        date_to=today.isoformat(),
    )

    assert response.status_code == 200
    assert [item["action"] for item in response.json()["items"]] == ["post_recent"]
    assert response.json()["total"] == 1


def test_default_period_is_the_last_week(client: TestClient, db_session: Session) -> None:
    """Без фильтров видна неделя: запись восьмидневной давности уже не показывается."""
    _owner_id, organization = owner_with_organization(client, db_session)
    now = datetime.now(UTC)
    add_event(
        db_session,
        organization_id=organization.id,
        action="post_last_week",
        created_at=now - timedelta(days=8),
    )
    add_event(
        db_session,
        organization_id=organization.id,
        action="post_two_days_ago",
        created_at=now - timedelta(days=2),
    )

    response = journal(client)

    assert [item["action"] for item in response.json()["items"]] == ["post_two_days_ago"]


def test_range_longer_than_limit_is_rejected(client: TestClient, db_session: Session) -> None:
    """Потолок периода — 90 дней: иначе запрос читает все месячные партиции."""
    owner_with_organization(client, db_session)
    today = today_moscow()

    too_long = journal(
        client,
        date_from=(today - timedelta(days=100)).isoformat(),
        date_to=today.isoformat(),
    )
    boundary = journal(
        client,
        date_from=(today - timedelta(days=89)).isoformat(),
        date_to=today.isoformat(),
    )

    assert too_long.status_code == 422
    assert "90" in too_long.json()["detail"]
    assert boundary.status_code == 200


def test_inverted_range_is_rejected(client: TestClient, db_session: Session) -> None:
    owner_with_organization(client, db_session)
    today = today_moscow()

    response = journal(
        client,
        date_from=today.isoformat(),
        date_to=(today - timedelta(days=1)).isoformat(),
    )

    assert response.status_code == 422


@pytest.mark.parametrize("limit", [0, -1, 201])
def test_limit_out_of_bounds_is_rejected(
    client: TestClient, db_session: Session, limit: int
) -> None:
    owner_with_organization(client, db_session)

    response = journal(client, limit=limit)

    assert response.status_code == 422


def test_period_day_is_moscow_not_utc(client: TestClient, db_session: Session) -> None:
    """Сутки периода считаются по Москве: запись в 01:30 МСК — в своём дне.

    Такой момент лежит в предыдущих UTC-сутках (22:30), поэтому фильтр «за
    вчера» в UTC отдал бы его за позавчера, а «за сегодня» — не отдал бы вовсе.
    """
    _owner_id, organization = owner_with_organization(client, db_session)
    day = today_moscow() - timedelta(days=1)
    # 01:30 московского дня `day` — это 22:30 UTC предыдущего дня.
    late_night = datetime.combine(day, time(1, 30), MOSCOW)
    assert late_night.astimezone(UTC).date() == day - timedelta(days=1)
    add_event(
        db_session,
        organization_id=organization.id,
        action="post_after_midnight",
        created_at=late_night,
    )

    own_day = journal(client, date_from=day.isoformat(), date_to=day.isoformat())
    utc_day = journal(
        client,
        date_from=(day - timedelta(days=1)).isoformat(),
        date_to=(day - timedelta(days=1)).isoformat(),
    )

    assert own_day.status_code == 200 and utc_day.status_code == 200
    assert [item["action"] for item in own_day.json()["items"]] == ["post_after_midnight"]
    # В сутках UTC этой записи нет: журнал живёт по московскому календарю.
    assert "post_after_midnight" not in [item["action"] for item in utc_day.json()["items"]]


def test_total_counts_the_whole_period_not_the_page(
    client: TestClient, db_session: Session
) -> None:
    """Подвал ленты: «За этот период — N записей», N не зависит от размера страницы."""
    _owner_id, organization = owner_with_organization(client, db_session)
    for _ in range(4):
        add_event(db_session, organization_id=organization.id)

    first_page = journal(client, limit=2)

    assert first_page.status_code == 200
    body = first_page.json()
    assert len(body["items"]) == 2
    assert body["total"] == 4
    assert body["next_cursor"] is not None


def test_total_respects_the_kind_filter(client: TestClient, db_session: Session) -> None:
    """`total` считается по тем же условиям, что и список: иначе число разошлось бы."""
    _owner_id, organization = owner_with_organization(client, db_session)
    add_event(
        db_session,
        organization_id=organization.id,
        kind=audit_rules.KIND_SECURITY,
        action="patch_organization",
    )
    for _ in range(3):
        add_event(db_session, organization_id=organization.id, kind=audit_rules.KIND_DATA)

    security = journal(client, kind=audit_rules.KIND_SECURITY)
    data = journal(client, kind=audit_rules.KIND_DATA)

    assert security.json()["total"] == 1
    assert data.json()["total"] == 3


def test_far_future_date_is_rejected_not_500(client: TestClient, db_session: Session) -> None:
    """`date_to=9999-12-31` — это 422 на ошибку ввода, а не `OverflowError` в 500."""
    owner_with_organization(client, db_session)
    today = today_moscow()

    only_future = journal(client, date_to=date.max.isoformat())
    whole_future_period = journal(
        client,
        date_from=date(9999, 1, 1).isoformat(),
        date_to=date.max.isoformat(),
    )
    # Длинный период с концом на краю календаря: 422 по длине, но не падение.
    long_period = journal(
        client,
        date_from=(today - timedelta(days=2)).isoformat(),
        date_to=date.max.isoformat(),
    )

    for response in (only_future, whole_future_period, long_period):
        assert response.status_code == 422, response.text


@pytest.mark.parametrize(
    ("params", "text"),
    [
        ({"date_from": date.min.isoformat(), "date_to": date.min.isoformat()}, "календар"),
        ({"date_to": date.min.isoformat()}, "календар"),
        ({"date_from": (today_moscow() + timedelta(days=1)).isoformat()}, "будущем"),
    ],
)
def test_unrepresentable_dates_are_rejected_not_500(
    client: TestClient, db_session: Session, params: dict[str, str], text: str
) -> None:
    """Край календаря и период целиком в будущем — 422 с понятным текстом."""
    owner_with_organization(client, db_session)

    response = journal(client, **params)

    assert response.status_code == 422, params
    assert text in response.json()["detail"]


def test_future_date_to_is_clipped_to_today(client: TestClient, db_session: Session) -> None:
    """Конец периода в будущем не ломает запрос: завтрашних записей всё равно нет."""
    _owner_id, organization = owner_with_organization(client, db_session)
    add_event(db_session, organization_id=organization.id, action="post_today")

    response = journal(client, date_to=(today_moscow() + timedelta(days=3)).isoformat())

    assert response.status_code == 200
    assert [item["action"] for item in response.json()["items"]] == ["post_today"]


def test_cursor_is_url_safe(client: TestClient, db_session: Session) -> None:
    """В курсоре нет `+`: иначе клиент, склеивший адрес строкой, получит 422."""
    _owner_id, organization = owner_with_organization(client, db_session)
    for _ in range(2):
        add_event(db_session, organization_id=organization.id)

    body = journal(client, limit=1).json()
    cursor = body["next_cursor"]

    assert cursor is not None
    assert "+" not in cursor
    # Момент в курсоре отдаётся как `...Z`, а не как `+00:00`.
    moment, _separator, identifier = cursor.rpartition("|")
    assert moment.endswith("Z")
    assert identifier.isdigit()
    # Вторая страница по этому курсору открывается: значение не испорчено.
    second = journal(client, limit=1, cursor=cursor)
    assert second.status_code == 200, second.text
    assert second.json()["items"]


def test_unknown_action_title_falls_back_to_the_code(
    client: TestClient, db_session: Session
) -> None:
    """Незнакомый код выводится кодом: название не придумывается."""
    _owner_id, organization = owner_with_organization(client, db_session)
    add_event(
        db_session,
        organization_id=organization.id,
        action="make_coffee",
        created_at=datetime.now(UTC),
    )

    response = journal(client)

    entry = next(item for item in response.json()["items"] if item["action"] == "make_coffee")
    assert entry["action_title"] == "make_coffee"


def test_broken_cursor_is_rejected(client: TestClient, db_session: Session) -> None:
    owner_with_organization(client, db_session)

    for cursor in ["мусор", "2026-10-22T10:00:00+00:00", "2026-10-22T10:00:00+00:00|abc"]:
        response = journal(client, cursor=cursor)
        assert response.status_code == 422, cursor


def test_reading_the_journal_does_not_write_to_it(client: TestClient, db_session: Session) -> None:
    """Чтение ничего не коммитит: иначе каждый просмотр оставлял бы свою строку."""
    owner_with_organization(client, db_session)

    def rows() -> int:
        db_session.expire_all()
        return db_session.scalar(select(func.count()).select_from(AuditEvent)) or 0

    before = rows()
    for _ in range(3):
        assert journal(client).status_code == 200

    assert rows() == before


def test_contract_documents_every_status_it_returns(client: TestClient) -> None:
    """Схема объявляет все коды, которые ручка реально возвращает."""
    schema = client.get("/openapi.json").json()
    operation = schema["paths"]["/api/journal"]["get"]

    assert {"200", "401", "403", "404", "422"} <= set(operation["responses"])
    # Вид действия объявлен перечислением: фронт берёт подписи по этим значениям.
    kind_parameter = next(
        parameter for parameter in operation["parameters"] if parameter["name"] == "kind"
    )
    assert set(kind_parameter["schema"]["anyOf"][0]["enum"]) == {
        audit_rules.KIND_SECURITY,
        audit_rules.KIND_DATA,
        audit_rules.KIND_NOISE,
    }
