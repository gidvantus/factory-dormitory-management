"""Организация пользователя: появление при активации, чтение и правка.

Критерии готовности issue #19 разложены по тестам по порядку: активация заводит
пустую организацию и владельца, повторная активация второй не создаёт,
`GET`/`PATCH /api/organization` работают, а проверки доступа дают разные коды —
404 «не привязан», 403 «роль без права правки», 403 «кабинет не активирован».
"""

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.organization import Organization, OrganizationMember
from app.models.user import User
from app.security import issue_activation_token
from tests.conftest import create_user, login, organizations_for, register_user

NEW_PASSWORD = "new-password-123"

# Пара ИНН, которой хватает на два разных теста: уникальность проверяется
# в пределах одной базы, а она у каждого теста своя.
INN_A = "7701234567"
INN_B = "770123456789"


def activate(
    client: TestClient, db_session: Session, user: User, password: str = NEW_PASSWORD
) -> None:
    """Активировать кабинет выпущенным заранее токеном."""
    raw_token = issue_activation_token(db_session, user.id)
    db_session.commit()
    response = client.post("/api/auth/activate", json={"token": raw_token, "password": password})
    assert response.status_code == 200, response.text


def organization_count(db_session: Session) -> int:
    return db_session.scalar(select(func.count()).select_from(Organization)) or 0


def owner_membership(db_session: Session, user_id: int) -> OrganizationMember:
    membership = db_session.scalar(
        select(OrganizationMember).where(OrganizationMember.user_id == user_id)
    )
    assert membership is not None
    return membership


# --- 1. Регистрация организации не создаёт -----------------------------------


def test_register_creates_neither_organization_nor_membership(
    client: TestClient, db_session: Session
) -> None:
    register_user(client)

    assert organization_count(db_session) == 0
    assert db_session.scalar(select(func.count()).select_from(OrganizationMember)) == 0


# --- 2. Активация заводит ровно одну пустую организацию и владельца ----------


def test_activate_creates_an_empty_organization_and_owner_membership(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="inactive@example.com", is_active=False)

    activate(client, db_session, user)

    db_session.expire_all()
    stored = db_session.get(User, user.id)
    assert stored is not None
    assert stored.active_organization_id is not None

    organization = db_session.get(Organization, stored.active_organization_id)
    assert organization is not None
    assert organization.name is None
    assert organization.inn is None
    assert organization.created_at is not None

    assert organization_count(db_session) == 1
    membership = owner_membership(db_session, user.id)
    assert membership.organization_id == organization.id
    assert membership.role == "owner"


def active_organization_id(db_session: Session, user_id: int) -> int | None:
    db_session.expire_all()
    stored = db_session.get(User, user_id)
    assert stored is not None
    return stored.active_organization_id


def test_repeated_activation_does_not_create_a_second_organization(
    client: TestClient, db_session: Session
) -> None:
    """Повторный вход по новой ссылке: организация остаётся одна."""
    user = create_user(db_session, email="inactive@example.com", is_active=False)
    activate(client, db_session, user)
    first_organization_id = active_organization_id(db_session, user.id)

    second_token = issue_activation_token(db_session, user.id)
    db_session.commit()
    second = client.post(
        "/api/auth/activate", json={"token": second_token, "password": "another-password-1"}
    )

    assert second.status_code == 200, second.text
    assert organization_count(db_session) == 1
    assert active_organization_id(db_session, user.id) == first_organization_id


def test_resend_then_activate_still_creates_one_organization(
    client: TestClient, db_session: Session
) -> None:
    """Через `activate/resend` второй организации тоже не появляется."""
    user = create_user(db_session, email="inactive@example.com", is_active=False)
    activate(client, db_session, user)
    assert client.post("/api/auth/activate/resend", json={"email": user.email}).status_code == 200

    assert organization_count(db_session) == 1


# --- 3. GET возвращает пустую заготовку --------------------------------------


def test_read_organization_returns_an_empty_blank(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.get("/api/organization")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] is None
    assert body["inn"] is None
    assert body["created_at"]
    assert isinstance(body["id"], int)


def test_read_organization_is_allowed_for_a_plain_member(
    client: TestClient, db_session: Session
) -> None:
    """Чтение — для любого участника: роль значения не имеет."""
    user = create_user(db_session, email="member@example.com")
    organizations_for(db_session, user, role="member", name="ООО Ромашка", inn=INN_A)
    assert login(client, user.email).status_code == 200

    response = client.get("/api/organization")

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "ООО Ромашка"
    assert response.json()["inn"] == INN_A


# --- 4. PATCH сохраняет значения ---------------------------------------------


def test_update_organization_saves_name_and_inn(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "ООО Ромашка", "inn": INN_A})

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "ООО Ромашка"
    assert response.json()["inn"] == INN_A

    db_session.expire_all()
    stored = db_session.get(Organization, response.json()["id"])
    assert stored is not None
    assert stored.name == "ООО Ромашка"
    assert stored.inn == INN_A

    # Последующий GET отдаёт то же самое.
    again = client.get("/api/organization")
    assert again.status_code == 200
    assert again.json() == response.json()


def test_update_organization_collapses_spaces_in_the_name(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "  ООО   «Ромашка»  "})

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "ООО «Ромашка»"


def test_update_organization_clears_the_inn_on_an_empty_value(
    client: TestClient, db_session: Session
) -> None:
    """Пустой ИНН — очистка поля: он необязательный, пустая заготовка допустима."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user, name="ООО Ромашка", inn=INN_A)
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "ООО Ромашка", "inn": ""})

    assert response.status_code == 200, response.text
    assert response.json()["inn"] is None
    stored = db_session.get(Organization, response.json()["id"])
    assert stored is not None
    assert stored.inn is None


def test_update_organization_accepts_a_twelve_digit_inn(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "ИП Иванов", "inn": INN_B})

    assert response.status_code == 200, response.text
    assert response.json()["inn"] == INN_B


def test_saving_the_same_inn_again_is_not_a_conflict(
    client: TestClient, db_session: Session
) -> None:
    """Сравнение идёт с другими организациями, а не с самой собой."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user, name="ООО Ромашка", inn=INN_A)
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "ООО Ромашка-2", "inn": INN_A})

    assert response.status_code == 200, response.text
    assert response.json()["inn"] == INN_A


# --- 5. Валидация ИНН и названия ---------------------------------------------


def test_update_organization_rejects_bad_inn(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    for bad_inn in ("12345", "770123456", "77012345678", "7701234567890", "abcdefghij"):
        response = client.patch("/api/organization", json={"name": "ООО Ромашка", "inn": bad_inn})
        assert response.status_code == 422, f"{bad_inn}: {response.status_code}"


def test_update_organization_rejects_a_blank_name(client: TestClient, db_session: Session) -> None:
    """Название обязательно: строка из пробелов — это 422, а не очистка."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    for blank_name in ("", "   "):
        response = client.patch("/api/organization", json={"name": blank_name, "inn": INN_A})
        assert response.status_code == 422, f"{blank_name!r}: {response.status_code}"


def test_update_organization_rejects_a_too_long_name(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "А" * 256, "inn": INN_A})

    assert response.status_code == 422


def test_validation_error_body_carries_the_reason_for_the_user(
    client: TestClient, db_session: Session
) -> None:
    """Тело 422 — список `detail`, и в нём есть и поле, и текст причины.

    Форма ответа важна для фронта: он достаёт из `loc` имя поля и показывает
    `msg`. Проверка держит контракт с обеих сторон, чтобы текст ошибки снова не
    подменился общим «Запрос не удался (422)».
    """
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "ООО Ромашка", "inn": "12345"})

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list) and detail
    entry = detail[0]
    assert entry["loc"] == ["body", "inn"]
    assert "ИНН должен состоять из 10 или 12 цифр" in entry["msg"]

    blank = client.patch("/api/organization", json={"name": "   ", "inn": INN_A})
    assert blank.status_code == 422
    blank_entry = blank.json()["detail"][0]
    assert blank_entry["loc"] == ["body", "name"]
    assert "Название не может быть пустым" in blank_entry["msg"]


def test_update_organization_rejects_an_unknown_field(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "ООО Ромашка", "role": "owner"})

    assert response.status_code == 422


def test_update_organization_conflicts_on_a_taken_inn(
    client: TestClient, db_session: Session
) -> None:
    """ИНН занят другой организацией — 409, и своя остаётся нетронутой."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user, name="ООО Ромашка")
    other = create_user(db_session, email="other@example.com")
    organizations_for(db_session, other, name="ООО Другая", inn=INN_B)
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "ООО Ромашка", "inn": INN_B})

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "Организация с таким ИНН уже есть"


# --- 6. Проверки доступа: 404, 403 -------------------------------------------


def test_organization_without_a_link_returns_404(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, email="lonely@example.com")
    assert login(client, user.email).status_code == 200

    assert client.get("/api/organization").status_code == 404
    patch = client.patch("/api/organization", json={"name": "ООО Ромашка"})
    assert patch.status_code == 404
    assert client.get("/api/organization").json()["detail"] == "Организация не найдена"


def test_membership_row_missing_returns_404(client: TestClient, db_session: Session) -> None:
    """Ссылка в `users` без строки членства — это тоже «не привязан»."""
    user = create_user(db_session, email="orphan@example.com")
    organization, membership = organizations_for(db_session, user)
    db_session.delete(membership)
    db_session.commit()
    assert organization.id is not None
    assert login(client, user.email).status_code == 200

    assert client.get("/api/organization").status_code == 404


def test_member_role_can_read_but_not_edit(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, email="member@example.com")
    organizations_for(db_session, user, role="member", name="ООО Ромашка")
    assert login(client, user.email).status_code == 200

    assert client.get("/api/organization").status_code == 200
    patch = client.patch("/api/organization", json={"name": "ООО Ромашка-2"})
    assert patch.status_code == 403, patch.text
    assert patch.json()["detail"] == "Недостаточно прав"


def test_admin_role_can_edit(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, email="admin@example.com")
    organizations_for(db_session, user, role="admin")
    assert login(client, user.email).status_code == 200

    response = client.patch("/api/organization", json={"name": "ООО Ромашка"})

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "ООО Ромашка"


def test_organization_requires_a_session(client: TestClient) -> None:
    assert client.get("/api/organization").status_code == 401
    assert client.patch("/api/organization", json={"name": "ООО Ромашка"}).status_code == 401


# --- 7. Неактивный кабинет ----------------------------------------------------


def test_inactive_user_gets_403_on_both_organization_endpoints(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="inactive@example.com", is_active=False)
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    get = client.get("/api/organization")
    patch = client.patch("/api/organization", json={"name": "ООО Ромашка"})

    assert get.status_code == 403, get.text
    assert patch.status_code == 403, patch.text
    assert get.json()["detail"] == "Активируйте личный кабинет"
    assert patch.json()["detail"] == "Активируйте личный кабинет"
