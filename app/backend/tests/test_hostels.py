"""Помесячная история хостелов и автосохранение таблиц мест."""

from fastapi.testclient import TestClient

from tests.conftest import register_user


def sign_in(client: TestClient) -> None:
    password = register_user(client, email="places@example.com")["password"]
    assert (
        client.post(
            "/api/auth/login", json={"email": "places@example.com", "password": password}
        ).status_code
        == 200
    )


def create_dormitory(client: TestClient) -> int:
    response = client.post("/api/dormitories", json={"name": "Северное", "client_name": "Клиент"})
    assert response.status_code == 201
    return response.json()["id"]


def test_hostels_carry_forward_and_keep_past_months(client: TestClient) -> None:
    assert client.get("/api/dormitories/1/hostels?from=2025-10-01&to=2025-10-31").status_code == 401
    sign_in(client)
    base = f"/api/dormitories/{create_dormitory(client)}/hostels"
    october = "2025-10-01"
    first = client.post(base, json={"name": "Хостел 1", "month": october})
    second = client.post(base, json={"name": "Хостел 2", "month": october})
    assert first.status_code == second.status_code == 201
    first_id = first.json()["id"]
    second_id = second.json()["id"]
    assert client.post(base, json={"name": "хостел 2", "month": october}).status_code == 409

    cell_base = f"{base}/{second_id}/cells/2025-10-15"
    assert client.put(f"{cell_base}/residents_m", json={"value": 4}).status_code == 204
    assert client.put(f"{cell_base}/residents_f", json={"value": 3}).status_code == 204
    assert client.put(f"{cell_base}/free_m", json={"value": 2}).status_code == 204
    assert client.put(f"{cell_base}/paid_f", json={"value": 5}).status_code == 204

    assert client.delete(f"{base}/{second_id}?month=2025-11-01").status_code == 204
    assert (
        client.put(
            f"{base}/{second_id}/cells/2025-11-10/residents_m", json={"value": 1}
        ).status_code
        == 409
    )
    assert client.delete(f"{base}/{second_id}?month=2025-11-01").status_code == 409

    replacement = client.post(base, json={"name": "Хостел 2", "month": "2025-12-01"})
    assert replacement.status_code == 201
    assert replacement.json()["id"] != second_id
    response = client.get(f"{base}?from=2025-10-01&to=2026-01-31")
    assert response.status_code == 200, response.text
    months = {item["month"]: item for item in response.json()["months"]}
    assert [item["name"] for item in months["2025-10-01"]["hostels"]] == ["Хостел 1", "Хостел 2"]
    assert [item["name"] for item in months["2025-11-01"]["hostels"]] == ["Хостел 1"]
    assert [item["name"] for item in months["2025-12-01"]["hostels"]] == ["Хостел 1", "Хостел 2"]
    assert [item["name"] for item in months["2026-01-01"]["hostels"]] == ["Хостел 1", "Хостел 2"]
    assert months["2025-10-01"]["days"][0] == "2025-10-01"
    old_hostel = months["2025-10-01"]["hostels"][1]
    assert old_hostel["id"] == second_id
    assert old_hostel["values"]["residents_total"]["2025-10-15"] == 7
    assert old_hostel["values"]["free_total"]["2025-10-15"] == 2
    assert old_hostel["values"]["paid_total"]["2025-10-15"] == 5
    assert months["2025-12-01"]["hostels"][1]["values"]["residents_total"] == {}
    assert months["2026-01-01"]["hostels"][0]["id"] == first_id


def test_hostel_dates_values_and_isolation(client: TestClient) -> None:
    sign_in(client)
    dormitory_id = create_dormitory(client)
    base = f"/api/dormitories/{dormitory_id}/hostels"
    assert client.post(base, json={"name": "А", "month": "2025-10-15"}).status_code == 422
    hostel_id = client.post(base, json={"name": "А", "month": "2025-10-01"}).json()["id"]
    assert client.post(base, json={"name": "А", "month": "2025-09-01"}).status_code == 409
    assert (
        client.put(f"{base}/{hostel_id}/cells/2025-09-30/free_m", json={"value": 1}).status_code
        == 409
    )
    assert (
        client.put(f"{base}/{hostel_id}/cells/2025-10-15/free_m", json={"value": -1}).status_code
        == 422
    )
    assert (
        client.put(f"{base}/{hostel_id}/cells/2025-10-15/free_m", json={"value": 0}).status_code
        == 204
    )
    assert client.get(f"{base}?from=2025-10-15&to=2025-10-16").json()["months"][0]["days"] == [
        "2025-10-15",
        "2025-10-16",
    ]
    assert (
        client.put(f"{base}/{hostel_id}/cells/2025-10-15/free_m", json={"value": None}).status_code
        == 204
    )
    assert (
        client.get(f"{base}?from=2025-10-15&to=2025-10-15").json()["months"][0]["hostels"][0][
            "values"
        ]["free_total"]
        == {}
    )
    other = create_dormitory(client)
    assert (
        client.get(f"/api/dormitories/{other}/hostels?from=2025-10-01&to=2025-10-31").json()[
            "months"
        ][0]["hostels"]
        == []
    )
    assert (
        client.delete(f"/api/dormitories/{other}/hostels/{hostel_id}?month=2025-11-01").status_code
        == 404
    )
