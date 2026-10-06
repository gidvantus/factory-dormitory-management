"""Таблица проживающих и привязка к действующим хостелам."""

from fastapi.testclient import TestClient

from tests.conftest import register_user


def test_residents_are_shared_and_deleted_only_after_request(client: TestClient) -> None:
    assert client.get("/api/dormitories/1/residents?month=2026-10-01").status_code == 401
    password = register_user(client, email="resident@example.com")["password"]
    assert (
        client.post(
            "/api/auth/login", json={"email": "resident@example.com", "password": password}
        ).status_code
        == 200
    )
    dormitory = client.post(
        "/api/dormitories", json={"name": "Северное", "client_name": "Клиент"}
    ).json()["id"]
    base = f"/api/dormitories/{dormitory}/residents"
    hostel = client.post(
        f"/api/dormitories/{dormitory}/hostels",
        json={"name": "Хостел 1", "month": "2026-09-01"},
    ).json()["id"]
    row = client.post(base)
    assert row.status_code == 201, row.text
    resident_id = row.json()["id"]
    assert row.json()["full_name"] is None
    assert (
        client.patch(
            f"{base}/{resident_id}?month=2026-10-01",
            json={
                "full_name": "Иванов Иван",
                "gender": "М",
                "hostel_id": hostel,
                "shift_count": 12,
                "phone": "+7 (999) 123-45-67",
            },
        ).status_code
        == 200
    )
    assert (
        client.patch(f"{base}/{resident_id}?month=2026-10-01", json={"shift_count": -1}).status_code
        == 422
    )
    assert (
        client.patch(f"{base}/{resident_id}?month=2026-10-01", json={"phone": "bad"}).status_code
        == 422
    )
    assert (
        client.patch(
            f"{base}/{resident_id}?month=2026-10-01",
            json={"shift_start": "2026-10-10", "shift_end": "2026-10-01"},
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"{base}/{resident_id}?month=2026-10-01", json={"shift_start": "2026-10-01"}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"{base}/{resident_id}?month=2026-10-01", json={"shift_end": "2026-10-30"}
        ).status_code
        == 200
    )

    response = client.get(f"{base}?month=2026-10-01")
    assert response.status_code == 200, response.text
    assert response.json()["hostels"] == [{"id": hostel, "name": "Хостел 1"}]
    assert response.json()["residents"][0]["full_name"] == "Иванов Иван"
    assert response.json()["residents"][0]["hostel_name"] == "Хостел 1"

    assert (
        client.delete(f"/api/dormitories/{dormitory}/hostels/{hostel}?month=2026-11-01").status_code
        == 204
    )
    november = client.get(f"{base}?month=2026-11-01").json()
    assert november["hostels"] == []
    assert november["residents"][0]["hostel_name"] == "Хостел 1"
    assert (
        client.patch(
            f"{base}/{resident_id}?month=2026-11-01", json={"hostel_id": hostel}
        ).status_code
        == 422
    )
    assert client.delete(f"{base}/{resident_id}").status_code == 204
    assert client.get(f"{base}?month=2026-11-01").json()["residents"] == []
