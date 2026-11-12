"""Прокси прав доступа: авторизация, передача галочки и отказа сервера."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.conftest import SERVICE_TOKEN, MainApi, login

PATH = "/api/access-rights"
ROW = {"role": "manager", "import_enabled": False, "export_enabled": True}
ROW.update(
    {
        section + "_enabled": True
        for section in (
            "overview",
            "dormitories",
            "personnel",
            "statistics",
            "documents",
            "shop",
            "organization",
            "members",
            "profile",
        )
    }
)


def test_session_is_required(client: TestClient, main_api: MainApi) -> None:
    assert client.get(PATH).status_code == 401
    assert client.patch(PATH + "/manager", json={"import_enabled": False}).status_code == 401
    assert not main_api.requests


def test_reads_platform_rights(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=[ROW])
    login(client)
    assert client.get(PATH).json() == [ROW]
    request = main_api.requests[-1]
    assert request.url.path == "/api/platform/access-rights"
    assert request.headers["X-Operator-Token"] == SERVICE_TOKEN


def test_forwards_only_changed_checkbox(client: TestClient, main_api: MainApi) -> None:
    main_api.handler = lambda request: httpx.Response(200, json=ROW)
    login(client)
    response = client.patch(PATH + "/manager", json={"import_enabled": False})
    assert response.status_code == 200
    assert response.json() == ROW
    request = main_api.requests[-1]
    assert request.method == "PATCH"
    assert request.url.path == "/api/platform/access-rights/manager"
    assert json.loads(request.content) == {"import_enabled": False}


def test_forwards_sidebar_checkbox_without_resetting_other_permissions(
    client: TestClient, main_api: MainApi
) -> None:
    main_api.handler = lambda request: httpx.Response(200, json={**ROW, "personnel_enabled": False})
    login(client)
    response = client.patch(PATH + "/manager", json={"personnel_enabled": False})
    assert response.status_code == 200
    assert response.json()["personnel_enabled"] is False
    assert response.json()["dormitories_enabled"] is True
    assert json.loads(main_api.requests[-1].content) == {"personnel_enabled": False}


@pytest.mark.parametrize("code", [422, 503])
def test_preserves_validation_error_or_gateway_error(
    client: TestClient, main_api: MainApi, code: int
) -> None:
    main_api.handler = lambda request: httpx.Response(code, json={"detail": "Проверка права"})
    login(client)
    response = client.patch(PATH + "/manager", json={"import_enabled": "false"})
    assert response.status_code == (502 if code == 503 else code)
