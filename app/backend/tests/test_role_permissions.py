"""Права оператора, независимость галочек и запрет обхода через прямые запросы."""

from collections.abc import Iterator
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.organization import OrganizationMember
from app.models.role_permission import ACCESS_ROLES, RolePermission
from app.role_permissions import EXPORT_FORBIDDEN_DETAIL, IMPORT_FORBIDDEN_DETAIL
from tests.conftest import add_colleague, login, sign_in

PLATFORM = "/api/platform/access-rights"
HEADERS = {"X-Operator-Token": "unit-test-permissions-token"}
MENU_ENABLED = {
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


@pytest.fixture(autouse=True)
def operator_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", HEADERS["X-Operator-Token"])
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def setup_role(client: TestClient, db: Session, role: str) -> tuple[int, int]:
    user = sign_in(client, db)
    dorm = client.post("/api/dormitories", json={"name": "Дом", "client_name": "Завод"}).json()[
        "id"
    ]
    member = db.scalar(select(OrganizationMember).where(OrganizationMember.user_id == user.id))
    assert member is not None
    member.role = role
    db.commit()
    assert user.active_organization_id is not None
    return dorm, user.active_organization_id


def test_only_operator_can_read_or_change_rights(client: TestClient, db_session: Session) -> None:
    sign_in(client, db_session)
    for headers in ({}, {"X-Operator-Token": "wrong"}):
        assert client.get(PLATFORM, headers=headers).status_code == 401
        assert (
            client.patch(
                PLATFORM + "/admin", headers=headers, json={"import_enabled": False}
            ).status_code
            == 401
        )
    body = client.get(PLATFORM, headers=HEADERS).json()
    assert [item["role"] for item in body] == list(ACCESS_ROLES)
    assert all(item["import_enabled"] and item["export_enabled"] for item in body)


def test_checkbox_patch_preserves_other_right_and_other_roles(client: TestClient) -> None:
    response = client.patch(PLATFORM + "/manager", headers=HEADERS, json={"import_enabled": False})
    assert response.status_code == 200, response.text
    assert response.json() == {
        **MENU_ENABLED,
        "role": "manager",
        "import_enabled": False,
        "export_enabled": True,
    }
    response = client.patch(PLATFORM + "/manager", headers=HEADERS, json={"export_enabled": False})
    assert response.json() == {
        **MENU_ENABLED,
        "role": "manager",
        "import_enabled": False,
        "export_enabled": False,
    }
    loaded = client.get(PLATFORM, headers=HEADERS).json()
    assert loaded[0] == response.json()
    assert all(item["import_enabled"] and item["export_enabled"] for item in loaded[1:])


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"import_enabled": "false"},
        {"export_enabled": 0},
        {"export_enabled": None},
        {"role": "owner"},
    ],
)
def test_invalid_changes_are_rejected(client: TestClient, payload: dict[str, object]) -> None:
    assert client.patch(PLATFORM + "/manager", headers=HEADERS, json=payload).status_code == 422
    assert client.get(PLATFORM, headers=HEADERS).json()[0]["import_enabled"] is True


@pytest.mark.parametrize("role", ["owner", "member", "unknown"])
def test_cannot_configure_other_roles(client: TestClient, role: str) -> None:
    assert (
        client.patch(
            PLATFORM + "/" + role, headers=HEADERS, json={"import_enabled": False}
        ).status_code
        == 422
    )


@pytest.mark.parametrize("role", [*ACCESS_ROLES, "member"])
def test_denied_roles_cannot_use_any_exchange_endpoint(
    client: TestClient, db_session: Session, role: str
) -> None:
    dorm, _ = setup_role(client, db_session, role)
    db_session.add(
        RolePermission(
            role="manager" if role == "member" else role, import_enabled=False, export_enabled=False
        )
    )
    db_session.commit()
    assert client.get("/api/me").json()["permissions"] == {
        **MENU_ENABLED,
        "import_enabled": False,
        "export_enabled": False,
    }
    exchange = f"/api/dormitories/{dorm}/data-transfer/residents"
    hostels = f"/api/dormitories/{dorm}/hostels/import"
    responses = [
        (client.get(exchange + "/template"), IMPORT_FORBIDDEN_DETAIL),
        (client.get(exchange + "/export"), EXPORT_FORBIDDEN_DETAIL),
        (
            client.post(exchange + "/import", files={"file": ("test.xlsx", b"invalid")}),
            IMPORT_FORBIDDEN_DETAIL,
        ),
        (client.get(hostels + "/template?month=2026-11-01"), IMPORT_FORBIDDEN_DETAIL),
        (client.post(hostels, files={"file": ("test.xlsx", b"invalid")}), IMPORT_FORBIDDEN_DETAIL),
        (client.post(hostels + "/1/confirm"), IMPORT_FORBIDDEN_DETAIL),
        (
            client.post("/api/personnel/export", json={"employee_ids": [str(uuid4())]}),
            EXPORT_FORBIDDEN_DETAIL,
        ),
    ]
    for response, detail in responses:
        assert response.status_code == 403, response.text
        assert response.json() == {"detail": detail}


def test_import_and_export_are_independent_and_revoked_in_active_session(
    client: TestClient, db_session: Session
) -> None:
    dorm, _ = setup_role(client, db_session, "admin")
    exchange = f"/api/dormitories/{dorm}/data-transfer/residents"
    assert client.get(exchange + "/template").status_code == 200
    client.patch(PLATFORM + "/admin", headers=HEADERS, json={"import_enabled": False})
    assert client.get(exchange + "/template").status_code == 403
    assert client.get(exchange + "/export").status_code == 200
    client.patch(
        PLATFORM + "/admin", headers=HEADERS, json={"import_enabled": True, "export_enabled": False}
    )
    assert client.get(exchange + "/template").status_code == 200
    assert client.get(exchange + "/export").status_code == 403


def test_owner_always_keeps_both_rights(client: TestClient, db_session: Session) -> None:
    dorm, _ = setup_role(client, db_session, "owner")
    for role in ACCESS_ROLES:
        db_session.add(RolePermission(role=role, import_enabled=False, export_enabled=False))
    db_session.commit()
    assert client.get("/api/me").json()["permissions"] == {
        **MENU_ENABLED,
        "import_enabled": True,
        "export_enabled": True,
    }
    exchange = f"/api/dormitories/{dorm}/data-transfer/residents"
    assert client.get(exchange + "/template").status_code == 200
    assert client.get(exchange + "/export").status_code == 200


def test_permission_belongs_to_role_across_organizations(
    client: TestClient, db_session: Session
) -> None:
    _, organization_id = setup_role(client, db_session, "manager")
    admin = add_colleague(db_session, organization_id, role="admin")
    client.patch(PLATFORM + "/manager", headers=HEADERS, json={"export_enabled": False})
    assert client.get("/api/me").json()["permissions"]["export_enabled"] is False
    assert login(client, admin.email).status_code == 200
    assert client.get("/api/me").json()["permissions"]["export_enabled"] is True
    other = sign_in(client, db_session, email="other-organization@example.com")
    membership = db_session.scalar(
        select(OrganizationMember).where(OrganizationMember.user_id == other.id)
    )
    assert membership is not None
    membership.role = "manager"
    db_session.commit()
    assert other.active_organization_id != organization_id
    assert client.get("/api/me").json()["permissions"]["export_enabled"] is False
