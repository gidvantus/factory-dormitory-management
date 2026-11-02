"""Платформенный контур кабинета оператора: список и правка организаций.

Проверяется то, что видит кабинет: сервисный токен в заголовке `X-Operator-Token`,
страницы списка, счётчики карточки и тексты отказов. Контур отдельный — cookie
основного кабинета (`crm_session`) его не открывает, и это проверяется здесь же:
иначе «закрытый» контур открывался бы любому вошедшему пользователю.
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.config import get_settings
from app.models.audit import AuditEvent
from app.models.dormitory import Dormitory
from app.models.organization import Organization
from app.schemas.organization import INN_FORMAT_MESSAGE, NAME_REQUIRED_MESSAGE
from app.security import INVALID_OPERATOR_TOKEN_DETAIL
from tests.conftest import add_colleague, create_user, login, organizations_for

# Заведомо ненастоящий секрет: настоящий в тестах не нужен.
SERVICE_TOKEN = "unit-test-operator-service-token"
OPERATOR_HEADERS = {"X-Operator-Token": SERVICE_TOKEN}
WRONG_HEADERS = {"X-Operator-Token": "not-the-token"}
PLATFORM = "/api/platform/organizations"

INN_A = "7707083893"
INN_B = "7736050003"


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


def make_organization(
    db_session: Session,
    *,
    email: str = "owner@example.com",
    name: str | None = "ООО Ромашка",
    inn: str | None = None,
) -> Organization:
    """Организация с владельцем — тем же помощником, что и остальные тесты."""
    user = create_user(db_session, email=email)
    organization, _ = organizations_for(db_session, user, name=name, inn=inn)
    return organization


# --- Токен ------------------------------------------------------------------


def test_missing_token_is_unauthorized(client: TestClient, operator_token: None) -> None:
    response = client.get(PLATFORM)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


def test_wrong_token_is_unauthorized(client: TestClient, operator_token: None) -> None:
    response = client.get(PLATFORM, headers=WRONG_HEADERS)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


def test_empty_configured_secret_closes_the_routes(
    client: TestClient, empty_operator_token: None
) -> None:
    """Пустой секрет — не «пускаем всех», а «закрыто совсем»."""
    response = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


def test_all_three_refusals_are_byte_identical(
    client: TestClient,
    empty_operator_token: None,
) -> None:
    """Точная причина отказа не называется: иначе ответ подсказывал бы, чего нет."""
    client.cookies.set("crm_session", "broken-session")
    no_header = client.get(PLATFORM)
    wrong_header = client.get(PLATFORM, headers=WRONG_HEADERS)
    empty_secret = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert no_header.content == wrong_header.content == empty_secret.content
    assert no_header.status_code == wrong_header.status_code == empty_secret.status_code == 401


def test_cabinet_cookie_does_not_open_the_platform_contour(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`crm_session` — cookie основного кабинета, а не пропуск в платформу."""
    user = create_user(db_session)
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.get(PLATFORM)

    assert response.status_code == 401
    assert response.json() == {"detail": INVALID_OPERATOR_TOKEN_DETAIL}


# --- Список -----------------------------------------------------------------


def test_list_returns_items_and_total(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    first = make_organization(db_session, email="a@example.com", name="ООО Первая")
    second = make_organization(db_session, email="b@example.com", name="ООО Вторая", inn=INN_A)
    blank = make_organization(db_session, email="c@example.com", name=None)

    response = client.get(PLATFORM, headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 3
    # Свежие сверху: порядок — по убыванию `id`, а не по названию (`name` бывает NULL).
    assert [item["id"] for item in body["items"]] == [blank.id, second.id, first.id]
    assert body["items"][0]["name"] is None
    assert body["items"][1]["inn"] == INN_A
    assert set(body["items"][0]) == {"id", "name", "inn", "created_at"}


def test_pages_do_not_repeat_or_skip_organizations(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    for index in range(5):
        make_organization(db_session, email=f"page{index}@example.com", name=f"ООО {index}")

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


def test_limit_and_offset_bounds_are_validated(client: TestClient, operator_token: None) -> None:
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"limit": 0}).status_code == 422
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"limit": 101}).status_code == 422
    assert client.get(PLATFORM, headers=OPERATOR_HEADERS, params={"offset": -1}).status_code == 422


# --- Карточка ---------------------------------------------------------------


def test_details_count_members_and_every_dormitory(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Владелец считается, архивное общежитие тоже: архив — статус, не удаление."""
    organization = make_organization(db_session)
    add_colleague(db_session, organization.id, email="colleague@example.com")
    db_session.add_all(
        [
            Dormitory(name="Первое", client_name="Первый", organization_id=organization.id),
            Dormitory(
                name="Второе",
                client_name="Второй",
                organization_id=organization.id,
                is_archived=True,
            ),
        ]
    )
    db_session.commit()

    response = client.get(f"{PLATFORM}/{organization.id}", headers=OPERATOR_HEADERS)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == organization.id
    assert body["members_count"] == 2
    assert body["dormitories_count"] == 2
    assert {"kpp", "ogrn", "address"} <= set(body)


def test_unknown_organization_is_not_found(client: TestClient, operator_token: None) -> None:
    response = client.get(f"{PLATFORM}/999999", headers=OPERATOR_HEADERS)

    assert response.status_code == 404
    assert response.json() == {"detail": "Организация не найдена"}


# --- Правка -----------------------------------------------------------------


def test_patch_changes_only_the_fields_it_was_given(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`PATCH` адреса не обнуляет название — и не трогает соседнюю организацию."""
    organization = make_organization(db_session, email="own@example.com", name="ООО Своя")
    neighbour = make_organization(
        db_session, email="other@example.com", name="ООО Соседняя", inn=INN_B
    )

    response = client.patch(
        f"{PLATFORM}/{organization.id}",
        headers=OPERATOR_HEADERS,
        json={"address": "г. Москва, ул. Ленина, 1"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "ООО Своя"
    assert response.json()["address"] == "г. Москва, ул. Ленина, 1"

    db_session.expire_all()
    refreshed = db_session.get(Organization, organization.id)
    assert refreshed is not None
    assert refreshed.name == "ООО Своя"
    assert refreshed.inn is None
    other = db_session.get(Organization, neighbour.id)
    assert other is not None
    assert other.name == "ООО Соседняя"
    assert other.inn == INN_B


def test_patch_with_empty_inn_clears_it(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = make_organization(db_session, inn=INN_A)

    response = client.patch(
        f"{PLATFORM}/{organization.id}", headers=OPERATOR_HEADERS, json={"inn": ""}
    )

    assert response.status_code == 200, response.text
    assert response.json()["inn"] is None


def test_patch_reports_a_taken_inn(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = make_organization(db_session, email="own@example.com", inn=INN_A)
    make_organization(db_session, email="other@example.com", inn=INN_B)

    response = client.patch(
        f"{PLATFORM}/{organization.id}", headers=OPERATOR_HEADERS, json={"inn": INN_B}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Организация с таким ИНН уже есть"}


def test_patch_rejects_an_empty_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = make_organization(db_session)

    response = client.patch(
        f"{PLATFORM}/{organization.id}", headers=OPERATOR_HEADERS, json={"name": "   "}
    )

    assert response.status_code == 422
    assert NAME_REQUIRED_MESSAGE in response.text


def test_patch_rejects_a_null_name(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """`name: null` — не очистка, а отказ: название организации пустым не бывает."""
    organization = make_organization(db_session)

    response = client.patch(
        f"{PLATFORM}/{organization.id}", headers=OPERATOR_HEADERS, json={"name": None}
    )

    assert response.status_code == 422
    assert response.json() == {"detail": NAME_REQUIRED_MESSAGE}
    db_session.expire_all()
    refreshed = db_session.get(Organization, organization.id)
    assert refreshed is not None and refreshed.name == "ООО Ромашка"


def test_patch_rejects_a_short_inn(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    organization = make_organization(db_session)

    response = client.patch(
        f"{PLATFORM}/{organization.id}", headers=OPERATOR_HEADERS, json={"inn": "12345"}
    )

    assert response.status_code == 422
    assert INN_FORMAT_MESSAGE in response.text


def test_patch_rejects_a_foreign_field(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Схема тела — та же, что в кабинете клиента: лишнее поле запрещено."""
    organization = make_organization(db_session)

    response = client.patch(
        f"{PLATFORM}/{organization.id}", headers=OPERATOR_HEADERS, json={"tariff_id": 1}
    )

    assert response.status_code == 422


def test_patch_leaves_a_security_row_in_the_journal(
    client: TestClient, db_session: Session, operator_token: None
) -> None:
    """Правка из кабинета оператора — действие безопасности, а не `data`."""
    organization = make_organization(db_session)

    response = client.patch(
        f"{PLATFORM}/{organization.id}", headers=OPERATOR_HEADERS, json={"name": "ООО Новая"}
    )
    assert response.status_code == 200, response.text

    row = events(db_session)[-1]
    assert row.kind == audit.KIND_SECURITY
    assert row.action == "patch_platform_organizations"
    assert row.path == "/api/platform/organizations/{organization_id}"
    assert row.path_params == {"organization_id": str(organization.id)}
    # Оператор кабинета — не пользователь платформы: актора и организации у него нет.
    assert row.actor_id is None
    assert row.organization_id is None
