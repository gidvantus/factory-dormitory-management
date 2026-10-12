"""Организация пользователя: появление при активации, чтение и правка.

Критерии готовности issue #19 разложены по тестам по порядку: активация заводит
пустую организацию и владельца, повторная активация второй не создаёт,
`GET`/`PATCH /api/organization` работают, а проверки доступа дают разные коды —
404 «не привязан», 403 «роль без права правки», 403 «кабинет не активирован».
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import dadata
from app.models.organization import Organization, OrganizationMember
from app.models.user import User
from app.security import issue_activation_token
from tests.conftest import create_user, login, organizations_for, register_user

NEW_PASSWORD = "new-password-123"

# Пара ИНН, которой хватает на два разных теста: уникальность проверяется
# в пределах одной базы, а она у каждого теста своя.
INN_A = "7701234567"
INN_B = "770123456789"

# Реквизиты, которые «нашла» DaData в тестах поиска.
LOOKUP_REQUISITES = dadata.OrganizationRequisites(
    name="ПАО СБЕРБАНК",
    kpp="773601001",
    ogrn="1027700132195",
    address="117312, г Москва, ул Вавилова, д 19",
)


def stub_lookup(
    monkeypatch: pytest.MonkeyPatch,
    *,
    result: dadata.OrganizationRequisites | None = None,
    fail: bool = False,
) -> list[str]:
    """Подменить поход в DaData. Возвращает список ИНН, с которыми искали."""
    calls: list[str] = []

    def fake(inn: str, **_kwargs: object) -> dadata.OrganizationRequisites | None:
        calls.append(inn)
        if fail:
            raise dadata.DadataUnavailable("сервис недоступен")
        return result

    monkeypatch.setattr(dadata, "lookup_organization", fake)
    return calls


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


# --- 8. Реквизиты организации: КПП, ОГРН, адрес -------------------------------


def test_update_organization_saves_requisites(client: TestClient, db_session: Session) -> None:
    """КПП, ОГРН и адрес сохраняются наравне с названием и ИНН."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.patch(
        "/api/organization",
        json={
            "name": "ПАО СБЕРБАНК",
            "inn": INN_A,
            "kpp": "773601001",
            "ogrn": "1027700132195",
            "address": "117312, г Москва, ул Вавилова, д 19",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["kpp"] == "773601001"
    assert body["ogrn"] == "1027700132195"
    assert body["address"] == "117312, г Москва, ул Вавилова, д 19"

    db_session.expire_all()
    stored = db_session.get(Organization, body["id"])
    assert stored is not None
    assert stored.kpp == "773601001"
    assert stored.ogrn == "1027700132195"
    assert stored.address == "117312, г Москва, ул Вавилова, д 19"

    # Реквизиты приходят и с сервера после перезагрузки страницы.
    again = client.get("/api/organization")
    assert again.status_code == 200
    assert again.json() == body


def test_read_organization_returns_null_requisites_for_a_blank(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    body = client.get("/api/organization").json()

    assert body["kpp"] is None
    assert body["ogrn"] is None
    assert body["address"] is None


def test_update_organization_clears_requisites_on_empty_values(
    client: TestClient, db_session: Session
) -> None:
    """Пустое значение очищает реквизит, как и `inn`: у ИП КПП не бывает вовсе."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200
    client.patch(
        "/api/organization",
        json={"name": "ПАО СБЕРБАНК", "inn": INN_A, "kpp": "773601001", "ogrn": "1027700132195"},
    )

    response = client.patch(
        "/api/organization",
        json={"name": "ИП Иванов", "inn": INN_B, "kpp": "", "ogrn": "   ", "address": ""},
    )

    assert response.status_code == 200, response.text
    assert response.json()["kpp"] is None
    assert response.json()["ogrn"] is None
    assert response.json()["address"] is None


def test_update_organization_rejects_a_too_long_requisite(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    for field, value in (("kpp", "1" * 10), ("ogrn", "1" * 16), ("address", "А" * 501)):
        response = client.patch("/api/organization", json={"name": "ООО Ромашка", field: value})
        assert response.status_code == 422, f"{field}: {response.status_code}"


# --- 9. Поиск организации по ИНН ---------------------------------------------


def test_lookup_returns_details_found_by_a_ten_digit_inn(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200
    calls = stub_lookup(monkeypatch, result=LOOKUP_REQUISITES)

    response = client.get("/api/organization/lookup", params={"inn": "7707083893"})

    assert response.status_code == 200, response.text
    assert response.json() == {
        "found": True,
        "reason": None,
        "details": {
            "name": "ПАО СБЕРБАНК",
            "kpp": "773601001",
            "ogrn": "1027700132195",
            "address": "117312, г Москва, ул Вавилова, д 19",
        },
    }
    assert calls == ["7707083893"]


def test_lookup_accepts_a_twelve_digit_inn_of_an_entrepreneur(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ИП: КПП пустой, но это не ошибка — `details.kpp` приходит `null`."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200
    stub_lookup(
        monkeypatch,
        result=dadata.OrganizationRequisites(
            name="ИП Иванов И.И.", kpp=None, ogrn="304500116000157", address="г Люберцы"
        ),
    )

    response = client.get("/api/organization/lookup", params={"inn": "500100732259"})

    assert response.status_code == 200, response.text
    assert response.json()["found"] is True
    assert response.json()["details"]["kpp"] is None
    assert response.json()["details"]["name"] == "ИП Иванов И.И."


def test_lookup_of_an_unknown_inn_is_not_found(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Не нашли — это 200, а не 404: форма остаётся рабочей."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200
    stub_lookup(monkeypatch, result=None)

    response = client.get("/api/organization/lookup", params={"inn": "7707083890"})

    assert response.status_code == 200, response.text
    assert response.json() == {"found": False, "reason": "not_found", "details": None}


def test_lookup_reports_unavailable_service(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200
    stub_lookup(monkeypatch, fail=True)

    response = client.get("/api/organization/lookup", params={"inn": "7707083893"})

    assert response.status_code == 200, response.text
    assert response.json() == {"found": False, "reason": "unavailable", "details": None}


def test_lookup_without_a_key_reports_unavailable_without_network(
    client: TestClient, db_session: Session
) -> None:
    """Пустой ключ — штатное «сервис недоступен», а не 500 и не поход в сеть.

    Клиент DaData здесь настоящий: тест держит и связку ручки с модулем, и
    поведение при незаданном ключе. Ключ пуст потому, что так его выставил
    `conftest` — на стенде он приходит из compose.
    """
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.get("/api/organization/lookup", params={"inn": "7707083893"})

    assert response.status_code == 200, response.text
    assert response.json() == {"found": False, "reason": "unavailable", "details": None}


def test_lookup_rejects_a_bad_inn(client: TestClient, db_session: Session) -> None:
    """ИНН не по формату — единственный 422 у поиска: это ошибка ввода."""
    user = create_user(db_session, email="owner@example.com")
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    for bad_inn in ("", "12345", "770708389", "77070838930", "abcdefghij"):
        response = client.get("/api/organization/lookup", params={"inn": bad_inn})
        assert response.status_code == 422, f"{bad_inn!r}: {response.status_code}"
        assert response.json()["detail"] == "ИНН должен состоять из 10 или 12 цифр"


def test_lookup_is_allowed_for_a_member_without_edit_rights(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Поиск — чтение: роли без права правки он доступен, в отличие от PATCH."""
    user = create_user(db_session, email="member@example.com")
    organizations_for(db_session, user, role="member")
    assert login(client, user.email).status_code == 200
    stub_lookup(monkeypatch, result=LOOKUP_REQUISITES)

    response = client.get("/api/organization/lookup", params={"inn": "7707083893"})

    assert response.status_code == 200, response.text
    assert response.json()["found"] is True


def test_lookup_requires_a_session(client: TestClient) -> None:
    assert client.get("/api/organization/lookup", params={"inn": "7707083893"}).status_code == 401


def test_lookup_returns_404_without_an_organization(
    client: TestClient, db_session: Session
) -> None:
    user = create_user(db_session, email="lonely@example.com")
    assert login(client, user.email).status_code == 200

    response = client.get("/api/organization/lookup", params={"inn": "7707083893"})

    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "Организация не найдена"


def test_lookup_on_an_inactive_cabinet_returns_403(client: TestClient, db_session: Session) -> None:
    user = create_user(db_session, email="inactive@example.com", is_active=False)
    organizations_for(db_session, user)
    assert login(client, user.email).status_code == 200

    response = client.get("/api/organization/lookup", params={"inn": "7707083893"})

    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "Активируйте личный кабинет"
