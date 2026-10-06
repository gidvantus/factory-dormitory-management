"""Дашборд считает обязательные итоговые строки всех общежитий."""

from fastapi.testclient import TestClient

from tests.conftest import register_user


def sign_in(client: TestClient) -> None:
    password = register_user(client, email="dashboard@example.com")["password"]
    assert (
        client.post(
            "/api/auth/login", json={"email": "dashboard@example.com", "password": password}
        ).status_code
        == 200
    )


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


def test_dashboard_aggregates_dormitories_clients_and_daily_formulas(client: TestClient) -> None:
    assert client.get("/api/dashboard?from=2025-09-01&to=2025-09-02").status_code == 401
    sign_in(client)
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


def test_dashboard_rejects_invalid_period_and_future_dates_have_no_data(client: TestClient) -> None:
    sign_in(client)
    dormitory(client, "Будущее", "Клиент", {})
    assert client.get("/api/dashboard?from=2025-09-03&to=2025-09-02").status_code == 422
    assert client.get("/api/dashboard?from=2025-01-01&to=2027-01-01").status_code == 422
    future = client.get("/api/dashboard?from=2099-01-01&to=2099-01-02").json()
    assert future["snapshot_date"] is None
    assert future["totals"] == {"attendance": None, "residents": None}
    assert future["daily"] == []
