"""Платформенный контур кабинета оператора: список, карточка и правка ФИО.

Проверяется то, что видит кабинет: сервисный токен в заголовке `X-Operator-Token`,
страницы списка с поиском, карточка, правка единственного поля ФИО и тексты
отказов. Контур отдельный — cookie основного кабинета (`crm_session`) его не
открывает, и это проверяется здесь же.

Главное правило задачи — в ответе нет ничего, кроме полей контракта, а правка
меняет только ФИО. Поэтому набор полей строки сверяется целиком, а неизменность
email, роли, организации и `is_active` проверяется и по ответу, и по базе.
"""

from collections.abc import Iterator
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app import db as db_module
from app.api.platform_users import USER_NOT_FOUND_DETAIL, _search_condition
from app.config import get_settings
from app.models.audit import AuditEvent
from app.models.organization import Organization
from app.models.user import User
from app.security import INVALID_OPERATOR_TOKEN_DETAIL
from tests.conftest import create_user, organizations_for

# Заведомо ненастоящий секрет: настоящий в тестах не нужен.
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}
WRONG_HEADERS = {"X-Operator-Token": "not-the-token"}
PLATFORM = "/api/platform/users"

# Поля контракта — ровно те, что в `PlatformUser`. Сверка набором, а не по
# одному: иначе лишнее персональное поле (согласие, пробный период) прошло бы
# незамеченным.
USER_FIELDS = {
    "id",
    "email",
    "full_name",
    "is_active",
    "organization_id",
    "organization_name",
    "role",
    "created_at",
}


@pytest.fixture
def operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Настроенный секрет сервисного контура. Кеш настроек сбрасывается до и после.

    Значение выставляется жёстко, а не `setdefault`: на стенде эта же переменная
    приходит из compose, а тест проверяет контракт, а не настройку стенда.
    """
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


@pytest.fixture
def empty_operator_token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Пустой секрет: платформенные ручки закрыты целиком."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", "")
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


def events(db_session: Session) -> list[AuditEvent]:
    """Строки журнала в порядке появления."""
    db_session.expire_all()
    return list(db_session.scalars(select(AuditEvent).order_by(AuditEvent.id)))


def make_member(
    db_session: Session,
    *,
    email: str = "owner@example.com",
    full_name: str = "Иванов Иван Иванович",
    role: str = "owner",
    organization_name: str | None = "ООО Ромашка",
) -> User:
    """Пользователь с организацией и строкой членства — через общие помощники."""
    user = create_user(db_session, email=email, full_name=full_name)
    organizations_for(db_session, user, role=role, name=organization_name)
    db_session.refresh(user)
    return user


# --- Токен ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", PLATFORM),
        ("get", f"{PLATFORM}/1"),
        ("patch", f"{PLATFORM}/1"),
    ],
)
def test_every_route_is_closed_without_the_service_token(
    client: TestClient, operator_token: None, method: str, path: str
) -> None:
    """Сессия основного кабинета сервисный токен не заменяет."""
    response = client.request(
        method, path, json={"full_name": "Иванов"} if method == "patch" else None
    )

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


@pytest.mark.parametrize(
    ("headers", "fixture_name"),
    [
        ({}, "operator_token"),
        (WRONG_HEADERS, "operator_token"),
        (OPERATOR_HEADERS, "empty_operator_token"),
    ],
)
def test_missing_wrong_and_empty_token_are_identical_refusals(
    client: TestClient,
    request: pytest.FixtureRequest,
    headers: dict[str, str],
    fixture_name: str,
) -> None:
    """Три отказа побайтово одинаковы: по ответу нельзя понять, чего не хватило."""
    request.getfixturevalue(fixture_name)

    response = client.get(PLATFORM, headers=headers)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


# --- Список -----------------------------------------------------------------


def test_list_returns_items_and_total(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    first = create_user(db_session, email="first@example.com", full_name="Первый Пётр")
    second = make_member(db_session, email="second@example.com", full_name="Второй Пётр")
    unactivated = create_user(
        db_session,
        email="dormant@example.com",
        full_name="Третий Пётр",
        is_active=False,
    )

    response = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 3
    # Свежие сверху: порядок — по убыванию `id`.
    assert [item["id"] for item in body["items"]] == [
        unactivated.id,
        second.id,
        first.id,
    ]
    for item in body["items"]:
        assert set(item) == USER_FIELDS
    # Неактивированная учётная запись в списке есть: `is_active` — не фильтр.
    assert body["items"][0]["is_active"] is False
    # Пользователь без организации: организация и роль — `null` вместе.
    assert body["items"][0]["organization_id"] is None
    assert body["items"][0]["organization_name"] is None
    assert body["items"][0]["role"] is None
    # Пользователь с организацией: имя и роль приходят из неё и из членства.
    assert body["items"][1]["organization_id"] == second.active_organization_id
    assert body["items"][1]["organization_name"] == "ООО Ромашка"
    assert body["items"][1]["role"] == "owner"


def test_pages_do_not_repeat_or_skip_users(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    for index in range(5):
        create_user(db_session, email=f"page{index}@example.com", full_name=f"Страница {index}")

    full = client.get(PLATFORM, headers=OPERATOR_HEADERS).json()
    expected = [item["id"] for item in full["items"]]

    first = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"limit": 2, "offset": 0})
    second = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"limit": 2, "offset": 2})

    assert first.status_code == second.status_code == 200
    page_ids = [item["id"] for item in first.json()["items"]]
    page_ids += [item["id"] for item in second.json()["items"]]
    assert page_ids == expected[:4]
    assert len(set(page_ids)) == len(page_ids)
    # `total` не зависит от страницы: по нему фронт решает, есть ли ещё.
    assert first.json()["total"] == second.json()["total"] == 5


def test_limit_offset_and_search_bounds_are_validated(
    client: TestClient, operator_token: None
) -> None:
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"limit": 0}).status_code == 422
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"limit": 101}).status_code == 422
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"offset": -1}).status_code == 422
    assert (
        client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"search": "я" * 101}).status_code
        == 422
    )


# --- Поиск ------------------------------------------------------------------


def test_search_finds_by_email_and_by_full_name_without_case(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Подстрока email и ФИО без учёта регистра.

    Регистр проверяется на латинице: `lower()` в SQLite знает только ASCII, и
    «ИВАНОВ» там не находится поиском «иванов». Кириллический регистр — поведение
    PostgreSQL, и его проверяет `dbtest` в конце файла.
    """
    by_email = create_user(db_session, email="Ivanov@Example.com", full_name="Пётр Сидоров")
    by_name = create_user(db_session, email="other@example.com", full_name="IVANOV IVAN")
    by_cyrillic = create_user(db_session, email="cyr@example.com", full_name="Иванов Иван")
    outsider = create_user(db_session, email="petrov@example.com", full_name="Пётр Петров")

    for search in ("ivan", "IVAN"):
        response = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"search": search})

        assert response.status_code == 200, response.text
        found = [item["id"] for item in response.json()["items"]]
        assert found == [by_name.id, by_email.id]
        assert outsider.id not in found
        assert by_cyrillic.id not in found

    russian = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"search": "Иванов"})

    assert [item["id"] for item in russian.json()["items"]] == [by_cyrillic.id]
    assert russian.json()["total"] == 1


def test_search_percent_does_not_return_everyone(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`search=%` — литерал, а не шаблон: иначе список отдал бы всю платформу."""
    create_user(db_session, email="first@example.com")
    create_user(db_session, email="second@example.com")

    response = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"search": "%"})

    assert response.status_code == 200, response.text
    assert response.json() == {"items": [], "total": 0}

    underscore = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"search": "_"})
    assert underscore.json() == {"items": [], "total": 0}


def test_search_by_percent_inside_a_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Экранирование не ломает поиск: `%` находится как обычный символ."""
    create_user(db_session, email="odd@example.com", full_name="Скидка 50% Петров")
    create_user(db_session, email="plain@example.com", full_name="Петров Пётр")

    response = client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"search": "50%"})

    assert [item["full_name"] for item in response.json()["items"]] == ["Скидка 50% Петров"]


# --- Карточка ---------------------------------------------------------------


def test_card_returns_the_contract_fields(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    user = make_member(db_session, role="admin", organization_name="ООО Лютик")

    response = client.get(f"{PLATFORM}/{user.id}", headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == USER_FIELDS
    assert body["id"] == user.id
    assert body["email"] == "owner@example.com"
    assert body["organization_name"] == "ООО Лютик"
    assert body["role"] == "admin"
    assert body["is_active"] is True


def test_unknown_user_is_not_found(client: TestClient, operator_token: None) -> None:
    response = client.get(f"{PLATFORM}/999999", headers=OPERATOR_HEADERS)

    assert response.status_code == 404
    assert response.json() == {"detail": USER_NOT_FOUND_DETAIL}


# --- Правка -----------------------------------------------------------------


def test_patch_collapses_spaces_and_changes_only_the_full_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    user = make_member(db_session, email="target@example.com", full_name="Старое ФИО", role="admin")
    organization = db_session.get(Organization, user.active_organization_id)
    assert organization is not None

    response = client.patch(
        f"{PLATFORM}/{user.id}",
        headers=OPERATOR_HEADERS,
        json={"full_name": "  Иванов  Иван  Иванович "},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["full_name"] == "Иванов Иван Иванович"
    # Остальные поля ответа — прежние: правка ФИО их не трогает.
    assert body["email"] == "target@example.com"
    assert body["is_active"] is True
    assert body["organization_id"] == organization.id
    assert body["organization_name"] == "ООО Ромашка"
    assert body["role"] == "admin"

    db_session.expire_all()
    refreshed = db_session.get(User, user.id)
    assert refreshed is not None
    assert refreshed.full_name == "Иванов Иван Иванович"
    assert refreshed.email == "target@example.com"
    assert refreshed.is_active is True
    assert refreshed.active_organization_id == organization.id


def test_patch_does_not_activate_an_unactivated_user(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`is_active` — «кабинет не активирован», и правка ФИО его не включает."""
    user = create_user(db_session, email="dormant@example.com", is_active=False)

    response = client.patch(
        f"{PLATFORM}/{user.id}", headers=OPERATOR_HEADERS, json={"full_name": "Новое ФИО"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["is_active"] is False
    assert response.json()["role"] is None

    db_session.expire_all()
    refreshed = db_session.get(User, user.id)
    assert refreshed is not None and refreshed.is_active is False


def test_patch_rejects_an_empty_full_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    user = create_user(db_session)

    response = client.patch(
        f"{PLATFORM}/{user.id}", headers=OPERATOR_HEADERS, json={"full_name": "   "}
    )

    assert response.status_code == 422
    assert "ФИО не может быть пустым" in response.text

    db_session.expire_all()
    refreshed = db_session.get(User, user.id)
    assert refreshed is not None and refreshed.full_name == "Иванов Иван Иванович"


def test_patch_rejects_a_foreign_field(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Лишнее поле, в том числе `email`, — `422`: правится только ФИО."""
    user = create_user(db_session, email="fixed@example.com")

    response = client.patch(
        f"{PLATFORM}/{user.id}",
        headers=OPERATOR_HEADERS,
        json={"full_name": "Иванов", "email": "new@example.com"},
    )

    assert response.status_code == 422

    db_session.expire_all()
    refreshed = db_session.get(User, user.id)
    assert refreshed is not None
    assert refreshed.email == "fixed@example.com"
    assert refreshed.full_name == "Иванов Иван Иванович"


def test_patch_of_an_unknown_user_is_not_found(client: TestClient, operator_token: None) -> None:
    response = client.patch(
        f"{PLATFORM}/999999", headers=OPERATOR_HEADERS, json={"full_name": "Иванов"}
    )

    assert response.status_code == 404
    assert response.json() == {"detail": USER_NOT_FOUND_DETAIL}


def test_patch_leaves_a_security_row_in_the_journal(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Правка из кабинета оператора — действие безопасности, а не `data`."""
    user = create_user(db_session)

    response = client.patch(
        f"{PLATFORM}/{user.id}", headers=OPERATOR_HEADERS, json={"full_name": "Новое ФИО"}
    )
    assert response.status_code == 200, response.text

    row = events(db_session)[-1]
    assert row.kind == audit.KIND_SECURITY
    assert row.action == "patch_platform_users"
    assert row.path == "/api/platform/users/{user_id}"
    assert row.path_params == {"user_id": str(user.id)}
    # Оператор кабинета — не пользователь платформы: актора и организации у него нет.
    assert row.actor_id is None
    assert row.organization_id is None


# --- Проверка на настоящей PostgreSQL ---------------------------------------


@pytest.mark.dbtest
def test_search_matches_a_cyrillic_full_name_without_case() -> None:
    """Регистр кириллицы — поведение PostgreSQL, а не SQLite.

    Юнит-прогон идёт на SQLite, где `lower()` знает только ASCII: «ИВАНОВ» там
    поиском «иванов» не находится. На стенде база — PostgreSQL, и кабинет обязан
    находить учётную запись в любом регистре. Строка заводится и убирается здесь
    же: чужой реестр тест не трогает.
    """
    marker = str(uuid4())
    with db_module.SessionLocal() as db:
        user = User(
            email=f"dbtest-{marker}@example.com",
            full_name="Иванов Иван Иванович",
            password_hash="dbtest",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        try:
            for term in ("иванов", "ИВАНОВ", "иВаНоВ"):
                found = db.scalars(select(User.id).where(_search_condition(term))).all()
                assert user.id in found
        finally:
            db.delete(user)
            db.commit()
