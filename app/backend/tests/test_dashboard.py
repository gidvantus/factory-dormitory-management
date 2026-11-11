"""Дашборд считает обязательные итоговые строки действующих общежитий."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import sign_in

DASHBOARD_EMAIL = "dashboard@example.com"


def test_renamed_report_rows_feed_builtin_blocks_and_independent_dates(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session, email=DASHBOARD_EMAIL)
    dorm = dormitory(client, "Северное", "Клиент", {"Выход Итого": "10"})
    base = f"/api/dormitories/{dorm}/report"
    period = "?from=2025-09-01&to=2025-09-02"
    rows = client.get(base + period).json()["rows"]
    row_id = next(row["id"] for row in rows if row["metric_key"] == "attendance")
    assert client.patch(f"{base}/rows/{row_id}", json={"name": "Работают"}).status_code == 200
    assert (
        client.post(base + "/rows", json={"name": "Выход Итого", "formula": "=999"}).status_code
        == 201
    )
    layout = client.get("/api/dashboard/layout").json()
    settings = {"attendance": {"name": "Смены", "date_mode": "range", "aggregate": "average"}}
    saved = client.put(
        "/api/dashboard/layout",
        json={
            "revision": layout["revision"],
            "order": layout["order"],
            "hidden": [],
            "builtin_settings": settings,
        },
    )
    assert saved.status_code == 200, saved.text
    assert client.get("/api/dashboard/layout").json()["builtin_settings"] == settings
    report = client.get(base + period).json()["rows"]
    assert next(row for row in report if row["id"] == row_id)["metric_block_name"] == "Смены"
    assert client.get("/api/dashboard" + period).json()["clients"] == [
        {"name": "Клиент", "attendance": 10}
    ]
    path = "/api/dashboard/breakdowns/attendance"
    for aggregate, value in [("last", 10), ("average", 5), ("sum", 10)]:
        response = client.get(path + period + "&aggregate=" + aggregate)
        assert response.status_code == 200, response.text
        assert response.json()["items"] == [{"id": "Клиент", "label": "Клиент", "value": value}]
    assert client.get(path + "?from=2025-09-01&to=2025-09-01").json()["items"][0]["value"] == 0


def dormitory(client: TestClient, name: str, customer: str, values: dict[str, str]) -> int:
    response = client.post("/api/dormitories", json={"name": name, "client_name": customer})
    assert response.status_code == 201
    dormitory_id = response.json()["id"]
    base = f"/api/dormitories/{dormitory_id}/report"
    for total_name, value in values.items():
        source = client.post(f"{base}/rows", json={"name": f"Источник {total_name}"})
        assert source.status_code == 201, source.text
        row = next(
            row
            for row in client.get(f"{base}?from=2025-09-01&to=2025-09-02").json()["rows"]
            if row["name"] == total_name
        )
        formula = f"=[Источник {total_name}]"
        assert (
            client.patch(f"{base}/rows/{row['id']}", json={"formula": formula}).status_code == 200
        )
        assert (
            client.put(
                f"{base}/rows/{source.json()['id']}/cells/2025-09-02", json={"value": value}
            ).status_code
            == 204
        )
    return dormitory_id


def test_dashboard_aggregates_dormitories_clients_and_daily_formulas(
    client: TestClient, db_session: Session
) -> None:
    assert client.get("/api/dashboard?from=2025-09-01&to=2025-09-02").status_code == 401
    sign_in(client, db_session, email=DASHBOARD_EMAIL)
    first = dormitory(
        client,
        "Северное",
        "Клиент А",
        {"Выход Итого": "4", "Проживает Итого": "10", "Текучка Итого": "1"},
    )
    dormitory(client, "Южное", "Клиент А", {"Выход Итого": "6", "Проживает Итого": "20"})
    result = client.get("/api/dashboard?from=2025-09-01&to=2025-09-02")
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["snapshot_date"] == "2025-09-02"
    assert data["totals"] == {"attendance": 10, "residents": 30}
    assert data["clients"] == [{"name": "Клиент А", "attendance": 10}]
    assert data["daily"] == [
        {"date": "2025-09-01", "attendance": 0, "residents": 0, "turnover": 0},
        {"date": "2025-09-02", "attendance": 10, "residents": 30, "turnover": 1},
    ]
    assert {row["name"]: row["residents"] for row in data["dormitories"]} == {
        "Северное": 10,
        "Южное": 20,
    }
    assert all(row["vacancies"] is None for row in data["dormitories"])

    selected = client.get(f"/api/dashboard?from=2025-09-01&to=2025-09-02&dormitory_id={first}")
    assert selected.status_code == 200, selected.text
    selected_data = selected.json()
    assert selected_data["totals"] == data["totals"]
    assert selected_data["clients"] == data["clients"]
    assert selected_data["daily"][1] == {
        "date": "2025-09-02",
        "attendance": 4,
        "residents": 10,
        "turnover": 1,
    }
    assert (
        client.get("/api/dashboard?from=2025-09-01&to=2025-09-02&dormitory_id=999").status_code
        == 404
    )

    dormitory(client, "Восточное", "Клиент Б", {"Выход Итого": "3", "Проживает Итого": "5"})
    refreshed = client.get("/api/dashboard?from=2025-09-02&to=2025-09-02").json()
    assert refreshed["totals"] == {"attendance": 13, "residents": 35}
    assert {row["name"]: row["attendance"] for row in refreshed["clients"]} == {
        "Клиент А": 10,
        "Клиент Б": 3,
    }

    base = f"/api/dormitories/{first}/report"
    row = next(
        row
        for row in client.get(f"{base}?from=2025-09-02&to=2025-09-02").json()["rows"]
        if row["name"] == "Выход Итого"
    )
    assert client.patch(f"{base}/rows/{row['id']}", json={"formula": "=1/0"}).status_code == 200
    broken = client.get("/api/dashboard?from=2025-09-02&to=2025-09-02").json()
    assert broken["totals"]["attendance"] is None
    assert broken["daily"][0]["attendance"] is None
    assert {row["name"]: row["attendance"] for row in broken["clients"]} == {
        "Клиент А": None,
        "Клиент Б": 3,
    }


def test_archived_dormitories_leave_dashboard_and_return_after_restore(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session, email=DASHBOARD_EMAIL)
    first = dormitory(
        client,
        "Северное",
        "Клиент А",
        {"Выход Итого": "4", "Проживает Итого": "10", "Текучка Итого": "1"},
    )
    second = dormitory(client, "Южное", "Клиент А", {"Выход Итого": "6", "Проживает Итого": "20"})
    url = "/api/dashboard?from=2025-09-01&to=2025-09-02"
    before = client.get(url).json()
    assert client.patch(f"/api/dormitories/{first}", json={"is_archived": True}).status_code == 200
    archived = client.get(url).json()
    assert [row["id"] for row in archived["dormitories"]] == [str(second)]
    assert archived["totals"] == {"attendance": 6, "residents": 20}
    assert archived["clients"] == [{"name": "Клиент А", "attendance": 6}]
    assert archived["daily"] == [
        {"date": "2025-09-01", "attendance": 0, "residents": 0, "turnover": 0},
        {"date": "2025-09-02", "attendance": 6, "residents": 20, "turnover": 0},
    ]
    assert client.get(f"{url}&dormitory_id={first}").status_code == 404
    # Архив остаётся в реестре, его таблицы и прежние значения доступны.
    assert first in [item["id"] for item in client.get("/api/dormitories").json()]
    report = client.get(f"/api/dormitories/{first}/report?from=2025-09-01&to=2025-09-02")
    assert report.status_code == 200
    resident_row = next(row for row in report.json()["rows"] if row["name"] == "Проживает Итого")
    assert resident_row["values"]["2025-09-02"] == "10"
    assert (
        client.patch(
            f"/api/dormitories/{first}", json={"name": "Новое", "client_name": "Клиент Б"}
        ).status_code
        == 200
    )
    renamed = client.get(url).json()
    for key in ("totals", "clients", "daily", "dormitories"):
        assert renamed[key] == archived[key]
    assert client.patch(f"/api/dormitories/{first}", json={"is_archived": False}).status_code == 200
    restored = client.get(url).json()
    assert restored["totals"] == before["totals"]
    assert restored["daily"] == before["daily"]
    assert {row["name"]: row["attendance"] for row in restored["clients"]} == {
        "Клиент А": 6,
        "Клиент Б": 4,
    }
    assert (
        next(row for row in restored["dormitories"] if row["id"] == str(first))["name"] == "Новое"
    )
    for dorm_id in (first, second):
        assert (
            client.patch(f"/api/dormitories/{dorm_id}", json={"is_archived": True}).status_code
            == 200
        )
    empty = client.get(url).json()
    assert empty["dormitories"] == []
    assert empty["clients"] == []
    assert empty["totals"] == {"attendance": None, "residents": None}
    assert all(
        day["attendance"] is day["residents"] is day["turnover"] is None for day in empty["daily"]
    )


def test_dashboard_rejects_invalid_period_and_future_dates_have_no_data(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session, email=DASHBOARD_EMAIL)
    dormitory(client, "Будущее", "Клиент", {})
    assert client.get("/api/dashboard?from=2025-09-03&to=2025-09-02").status_code == 422
    assert client.get("/api/dashboard?from=2025-01-01&to=2027-01-01").status_code == 422
    future = client.get("/api/dashboard?from=2099-01-01&to=2099-01-02").json()
    assert future["snapshot_date"] is None
    assert future["totals"] == {"attendance": None, "residents": None}
    assert future["daily"] == []
