"""Проверка живости и схема контракта.

`/api/health` — единственная ручка кабинета, открытая анониму: по ней стенд
понимает, что сервис поднялся. Схема OpenAPI проверяется здесь же: это контракт,
который читает фронтенд, и пропажа ручки или описания отказа — регресс.
"""

from fastapi.testclient import TestClient

from app.security import LOGIN_FAILED_DETAIL, UNAUTHORIZED_DETAIL


def test_health_reports_ok(client: TestClient) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_needs_no_session(client: TestClient) -> None:
    """Healthcheck стенда не может ждать входа."""
    response = client.get("/api/health")

    assert response.status_code == 200


def test_openapi_documents_the_contract(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()

    assert set(schema["paths"]) == {
        "/api/auth/login",
        "/api/auth/me",
        "/api/auth/logout",
        "/api/health",
        # Организации платформы: чтение и правка через сервисный контур.
        "/api/organizations",
        "/api/organizations/{organization_id}",
        # Тариф и расширения организации — часть той же карточки: чтение,
        # правка срока и два снятия активности (#189).
        "/api/organizations/{organization_id}/subscription",
        "/api/organizations/{organization_id}/subscription/deactivate",
        "/api/organizations/{organization_id}/solutions/{code}/deactivate",
        # Пользователи платформы: тот же контур, второй раздел кабинета.
        "/api/users",
        "/api/users/{user_id}",
        # Вход под пользователем (#201) — одна ручка-прокси: ссылку собирает
        # основной API, сессию по ней ставит сайт, а не кабинет.
        "/api/users/{user_id}/impersonate",
        # Счета платформы: третий раздел — реестр всех организаций, оплата,
        # отмена и печатные формы.
        "/api/invoices",
        "/api/invoices/{invoice_id}",
        "/api/invoices/{invoice_id}/file",
        "/api/invoices/{invoice_id}/act-file",
        # Тарифы платформы: четвёртый раздел — весь прайс, правка полей и
        # снятие с продажи.
        "/api/tariffs",
        "/api/tariffs/{tariff_id}",
        # Реквизиты поставщика — пятый раздел: единственная строка, которую
        # правят в кабинете и из которой печатные формы берут блок «Поставщик» и
        # строку про НДС (#179).
        "/api/company-details",
        # Решения магазина улучшений — шестой раздел: весь каталог, правка полей
        # и снятие с продажи (#188).
        "/api/solutions",
        "/api/solutions/{solution_id}",
        "/api/access-rights",
        "/api/access-rights/{role}",
    }
    login = schema["paths"]["/api/auth/login"]["post"]
    assert login["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "OperatorResponse"
    )
    assert login["responses"]["401"]["description"] == LOGIN_FAILED_DETAIL
    assert schema["paths"]["/api/auth/me"]["get"]["responses"]["401"]["description"] == (
        UNAUTHORIZED_DETAIL
    )
    assert schema["paths"]["/api/auth/logout"]["post"]["responses"]["204"] is not None


def test_openapi_documents_the_platform_contour(client: TestClient) -> None:
    """Отказы организаций — часть контракта: фронт показывает `detail` дословно."""
    schema = client.get("/openapi.json").json()
    listing = schema["paths"]["/api/organizations"]["get"]
    details = schema["paths"]["/api/organizations/{organization_id}"]["get"]
    update = schema["paths"]["/api/organizations/{organization_id}"]["patch"]

    assert listing["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "OrganizationPage"
    )
    for operation in (listing, details, update):
        assert operation["responses"]["401"]["description"] == UNAUTHORIZED_DETAIL
        assert operation["responses"]["502"] is not None
        assert operation["responses"]["503"] is not None
    assert details["responses"]["404"] is not None
    assert update["responses"]["409"] is not None
    assert update["responses"]["422"] is not None


def test_openapi_documents_the_subscription_contour(client: TestClient) -> None:
    """Тариф и расширения: все четыре ручки отвечают одним объектом состояния.

    `204` у команд нет намеренно: после действия экран показывает ответ, поэтому
    `200` объявлен у всех трёх write-ручек. `404` и `422` приходят из основного
    API дословно, значит обязаны быть в схеме, которую читает фронтенд.
    """
    schema = client.get("/openapi.json").json()
    reading = schema["paths"]["/api/organizations/{organization_id}/subscription"]["get"]
    update = schema["paths"]["/api/organizations/{organization_id}/subscription"]["patch"]
    deactivate = schema["paths"]["/api/organizations/{organization_id}/subscription/deactivate"][
        "post"
    ]
    deactivate_solution = schema["paths"][
        "/api/organizations/{organization_id}/solutions/{code}/deactivate"
    ]["post"]

    for operation in (reading, update, deactivate, deactivate_solution):
        assert operation["responses"]["200"]["content"]["application/json"]["schema"][
            "$ref"
        ].endswith("SubscriptionState")
        assert "204" not in operation["responses"]
        assert operation["responses"]["401"]["description"] == UNAUTHORIZED_DETAIL
        assert operation["responses"]["502"] is not None
        assert operation["responses"]["503"] is not None
    assert reading["responses"]["404"] is not None
    assert update["responses"]["404"] is not None
    assert update["responses"]["422"] is not None
    # Слот без тарифа: обе write-ручки объявляют `409` одним описанием — отказ
    # приходит из основного API дословно (ревью №1, Б1 и Б3).
    assert (
        update["responses"]["409"]["description"] == deactivate["responses"]["409"]["description"]
    )
    assert "409" not in reading["responses"]
    assert deactivate["responses"]["404"] is not None
    assert deactivate_solution["responses"]["404"] is not None


def test_openapi_documents_the_users_contour(client: TestClient) -> None:
    """Отказы пользователей — тоже контракт: `detail` приходит из основного API."""
    schema = client.get("/openapi.json").json()
    listing = schema["paths"]["/api/users"]["get"]
    details = schema["paths"]["/api/users/{user_id}"]["get"]
    update = schema["paths"]["/api/users/{user_id}"]["patch"]
    # Вход под пользователем (#201): тела нет, `422` у ручки поэтому нет вовсе,
    # а `409` («Кабинет не активирован») приходит из основного API дословно.
    impersonate = schema["paths"]["/api/users/{user_id}/impersonate"]["post"]

    assert listing["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "PlatformUserPage"
    )
    for operation in (listing, details, update, impersonate):
        assert operation["responses"]["401"]["description"] == UNAUTHORIZED_DETAIL
        assert operation["responses"]["502"] is not None
        assert operation["responses"]["503"] is not None
    assert details["responses"]["404"] is not None
    assert update["responses"]["404"] is not None
    assert update["responses"]["422"] is not None
    assert impersonate["responses"]["200"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("ImpersonationLink")
    assert impersonate["responses"]["404"] is not None
    assert impersonate["responses"]["409"] is not None


def test_openapi_documents_the_invoices_contour(client: TestClient) -> None:
    """Отказы счетов — тоже контракт: `detail` приходит из основного API дословно."""
    schema = client.get("/openapi.json").json()
    listing = schema["paths"]["/api/invoices"]["get"]
    update = schema["paths"]["/api/invoices/{invoice_id}"]["patch"]
    invoice_file = schema["paths"]["/api/invoices/{invoice_id}/file"]["get"]
    act_file = schema["paths"]["/api/invoices/{invoice_id}/act-file"]["get"]

    assert listing["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "PlatformInvoicePage"
    )
    for operation in (listing, update, invoice_file, act_file):
        assert operation["responses"]["401"]["description"] == UNAUTHORIZED_DETAIL
        assert operation["responses"]["502"] is not None
        assert operation["responses"]["503"] is not None
    assert update["responses"]["404"] is not None
    assert update["responses"]["409"] is not None
    assert update["responses"]["422"] is not None
    assert invoice_file["responses"]["404"] is not None
    assert act_file["responses"]["404"] is not None


def test_openapi_documents_the_tariffs_contour(client: TestClient) -> None:
    """Тарифы: список — `list[Tariff]`, удаление — `204` без тела."""
    schema = client.get("/openapi.json").json()
    listing = schema["paths"]["/api/tariffs"]["get"]
    update = schema["paths"]["/api/tariffs/{tariff_id}"]["patch"]
    delete = schema["paths"]["/api/tariffs/{tariff_id}"]["delete"]

    assert listing["responses"]["200"]["content"]["application/json"]["schema"]["items"][
        "$ref"
    ].endswith("Tariff")
    for operation in (listing, update, delete):
        assert operation["responses"]["401"]["description"] == UNAUTHORIZED_DETAIL
        assert operation["responses"]["502"] is not None
        assert operation["responses"]["503"] is not None
    assert update["responses"]["404"] is not None
    assert update["responses"]["409"] is not None
    assert update["responses"]["422"] is not None
    # `DELETE` отвечает пустым телом: 204 объявлен, а 200 у него нет.
    assert "204" in delete["responses"]
    assert "200" not in delete["responses"]


def test_openapi_documents_the_solutions_contour(client: TestClient) -> None:
    """Решения магазина: список — `list[Solution]`, удаление — `204` без тела.

    Отказы — контракт кабинета: `404`/`409`/`422` приходят из основного API
    дословно, поэтому коды обязаны быть в схеме, которую читает фронтенд.
    """
    schema = client.get("/openapi.json").json()
    listing = schema["paths"]["/api/solutions"]["get"]
    update = schema["paths"]["/api/solutions/{solution_id}"]["patch"]
    delete = schema["paths"]["/api/solutions/{solution_id}"]["delete"]

    assert listing["responses"]["200"]["content"]["application/json"]["schema"]["items"][
        "$ref"
    ].endswith("Solution")
    for operation in (listing, update, delete):
        assert operation["responses"]["401"]["description"] == UNAUTHORIZED_DETAIL
        assert operation["responses"]["502"] is not None
        assert operation["responses"]["503"] is not None
    assert update["responses"]["404"] is not None
    assert update["responses"]["409"] is not None
    assert update["responses"]["422"] is not None
    assert delete["responses"]["404"] is not None
    # `DELETE` отвечает пустым телом: 204 объявлен, а 200 у него нет.
    assert "204" in delete["responses"]
    assert "200" not in delete["responses"]


def test_openapi_documents_the_company_contour(client: TestClient) -> None:
    """Реквизиты поставщика: чтение и правка, отказы — контракт кабинета.

    `422` объявлен у правки: тексты форматов приходят из основного API и
    показываются дословно, поэтому код обязан быть в схеме, которую читает
    фронтенд. `404` — «строка не заведена»: создавать её кабинет не умеет.
    """
    schema = client.get("/openapi.json").json()
    reading = schema["paths"]["/api/company-details"]["get"]
    update = schema["paths"]["/api/company-details"]["patch"]

    assert reading["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "CompanyDetails"
    )
    for operation in (reading, update):
        assert operation["responses"]["401"]["description"] == UNAUTHORIZED_DETAIL
        assert operation["responses"]["502"] is not None
        assert operation["responses"]["503"] is not None
    assert update["responses"]["404"] is not None
    assert update["responses"]["422"] is not None
