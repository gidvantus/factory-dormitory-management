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
        # Пользователи платформы: тот же контур, второй раздел кабинета.
        "/api/users",
        "/api/users/{user_id}",
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


def test_openapi_documents_the_users_contour(client: TestClient) -> None:
    """Отказы пользователей — тоже контракт: `detail` приходит из основного API."""
    schema = client.get("/openapi.json").json()
    listing = schema["paths"]["/api/users"]["get"]
    details = schema["paths"]["/api/users/{user_id}"]["get"]
    update = schema["paths"]["/api/users/{user_id}"]["patch"]

    assert listing["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "PlatformUserPage"
    )
    for operation in (listing, details, update):
        assert operation["responses"]["401"]["description"] == UNAUTHORIZED_DETAIL
        assert operation["responses"]["502"] is not None
        assert operation["responses"]["503"] is not None
    assert details["responses"]["404"] is not None
    assert update["responses"]["404"] is not None
    assert update["responses"]["422"] is not None
