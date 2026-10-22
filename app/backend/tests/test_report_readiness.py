"""Готовность отдельна от структуры отчёта, периода и отметок предыдущих дней."""

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import report_readiness
from app.models.report_readiness import ReportReadiness
from tests.conftest import add_colleague, login, sign_in


def create_dormitory(client: TestClient, name: str) -> int:
    response = client.post(
        "/api/dormitories", json={"name": name, "client_name": "Клиент", "tabs": []}
    )
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def test_readiness_is_daily_shared_and_independent_of_report_fields(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(report_readiness, "today_moscow", lambda: date(2026, 10, 9))
    user = sign_in(client, db_session)
    first = create_dormitory(client, "Северное")
    second = create_dormitory(client, "Южное")
    url = f"/api/dormitories/{first}/report-readiness"
    assert client.get(url).json() == {
        "report_date": "2026-10-09",
        "is_ready": False,
        "confirmed_at": None,
        "confirmed_by": None,
    }
    payload = {"report_date": "2026-10-09", "is_ready": True}
    saved = client.put(url, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["is_ready"] is True
    assert saved.json()["confirmed_by"] == user.full_name
    assert saved.json()["confirmed_at"]
    assert client.put(url, json=payload).json() == saved.json()
    assert db_session.scalar(select(func.count()).select_from(ReportReadiness)) == 1
    assert client.get(f"/api/dormitories/{second}/report-readiness").json()["is_ready"] is False
    # Готовность общая внутри организации, а не личная: коллега видит ту же отметку.
    colleague = add_colleague(db_session, user.active_organization_id or 0)
    assert login(client, colleague.email).status_code == 200
    assert client.get(url).json() == saved.json()
    # Даже при выборе прошлого/будущего периода индикатор относится к сегодня.
    for period in ("from=2025-09-01&to=2025-09-02", "from=2099-01-01&to=2099-01-02"):
        dashboard = client.get(f"/api/dashboard?{period}").json()
        assert dashboard["report_date"] == "2026-10-09"
        statuses = {item["id"]: item["report_readiness"] for item in dashboard["dormitories"]}
        assert statuses[str(first)] == saved.json()
        assert statuses[str(second)]["is_ready"] is False
    undone = client.put(url, json={**payload, "is_ready": False})
    assert undone.json()["is_ready"] is False
    assert undone.json()["confirmed_at"] is None
    assert undone.json()["confirmed_by"] is None
    assert client.get(url).json() == undone.json()


def test_new_day_does_not_copy_yesterday_and_rejects_stale_checkbox(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(report_readiness, "today_moscow", lambda: date(2026, 10, 9))
    sign_in(client, db_session)
    dormitory_id = create_dormitory(client, "Северное")
    url = f"/api/dormitories/{dormitory_id}/report-readiness"
    payload = {"report_date": "2026-10-09", "is_ready": True}
    assert client.put(url, json=payload).status_code == 200
    monkeypatch.setattr(report_readiness, "today_moscow", lambda: date(2026, 10, 10))
    assert client.get(url).json()["is_ready"] is False
    assert client.get(url).json()["report_date"] == "2026-10-10"
    assert client.put(url, json=payload).status_code == 409
    assert client.put(url, json={**payload, "report_date": "2026-10-10"}).status_code == 200
    rows = list(db_session.scalars(select(ReportReadiness).order_by(ReportReadiness.report_date)))
    assert [(row.report_date, row.is_ready) for row in rows] == [
        (date(2026, 10, 9), True),
        (date(2026, 10, 10), True),
    ]


def test_readiness_requires_active_session_and_valid_dormitory(
    client: TestClient, db_session: Session
) -> None:
    url = "/api/dormitories/999/report-readiness"
    payload = {"report_date": report_readiness.today_moscow().isoformat(), "is_ready": True}
    assert client.get(url).status_code == 401
    assert client.put(url, json=payload).status_code == 401
    sign_in(client, db_session, is_active=False)
    assert client.get(url).status_code == 403
    assert client.put(url, json=payload).status_code == 403
    sign_in(client, db_session, email="active@example.com")
    assert client.get(url).status_code == 404
    assert client.put(url, json=payload).status_code == 404
    # Права проверяются раньше разбора тела: на несуществующем общежитии
    # неверное тело до проверки тела не доходит — ответ тот же 404.
    assert client.put(url, json={**payload, "is_ready": "yes"}).status_code == 404
    existing = f"/api/dormitories/{create_dormitory(client, 'Северное')}/report-readiness"
    assert client.put(existing, json={**payload, "is_ready": "yes"}).status_code == 422
    assert login(client, "active@example.com").status_code == 200
