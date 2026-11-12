"""Отдельные права разделов нельзя обойти прямым запросом к API."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.role_permission import RolePermission
from tests.test_role_permissions import HEADERS, PLATFORM, setup_role


@pytest.mark.parametrize("role", ["manager", "admin", "commandant"])
@pytest.mark.parametrize(
    "section,path",
    [
        ("overview", "/api/dashboard/layout"),
        ("personnel", "/api/personnel/arrivals"),
        ("statistics", "/api/statistics/reports"),
        ("documents", "/api/billing/invoices"),
        ("shop", "/api/solutions"),
        ("organization", "/api/organization"),
        ("members", "/api/organization/members"),
        ("dormitories", "/api/dormitories"),
    ],
)
def test_closed_section_is_denied_and_can_be_enabled(
    client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    role: str,
    section: str,
    path: str,
) -> None:
    from app.config import get_settings

    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", HEADERS["X-Operator-Token"])
    get_settings.cache_clear()
    try:
        dorm, _ = setup_role(client, db_session, role)
        response = client.patch(
            f"{PLATFORM}/{role}", headers=HEADERS, json={section + "_enabled": False}
        )
        assert response.status_code == 200, response.text
        assert client.get(path).status_code == 403
        assert client.get("/api/me").json()["permissions"][section + "_enabled"] is False
        # Выключение одного раздела не выключает другой.
        alternate = "/api/organization" if section != "organization" else "/api/dormitories"
        assert client.get(alternate).status_code == 200
        if section == "dormitories":
            assert client.get(f"/api/dormitories/{dorm}/settings").status_code == 403
            assert (
                client.post(
                    "/api/dormitories", json={"name": "Новый", "client_name": "Клиент"}
                ).status_code
                == 403
            )
        if section == "shop":
            assert client.get("/api/solutions/entitlements").status_code == 200
        assert (
            client.patch(
                f"{PLATFORM}/{role}", headers=HEADERS, json={section + "_enabled": True}
            ).status_code
            == 200
        )
        assert client.get(path).status_code == 200
    finally:
        get_settings.cache_clear()


def test_owner_and_session_keep_access_when_all_sections_disabled(
    client: TestClient, db_session: Session
) -> None:
    setup_role(client, db_session, "owner")
    for role in ("manager", "admin", "commandant"):
        db_session.add(
            RolePermission(
                role=role,
                **{
                    section + "_enabled": False
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
                },
            )
        )
    db_session.commit()
    assert all(client.get("/api/me").json()["permissions"].values())
    assert client.get("/api/dormitories").status_code == 200
    assert client.get("/api/organization").status_code == 200


def test_closed_personnel_does_not_block_adding_a_dormitory_resident(
    client: TestClient, db_session: Session
) -> None:
    from tests.test_personnel import create

    dorm, _ = setup_role(client, db_session, "commandant")
    db_session.add(RolePermission(role="commandant", personnel_enabled=False))
    db_session.commit()
    assert client.get("/api/personnel").status_code == 403
    row = create(client, dorm)
    assert row["row_id"] > 0
    assert client.get(f"/api/personnel/employees/{row['employee_id']}").status_code == 403
    assert client.get(f"/api/dormitories/{dorm}/residents?month=2026-11-01").status_code == 200
