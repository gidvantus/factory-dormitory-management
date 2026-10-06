"""Отток персонала: поля, период, изоляция и удаление."""

from fastapi.testclient import TestClient

from tests.conftest import register_user


def test_outflow_rows_are_persistent_filtered_and_isolated(client: TestClient) -> None:
    assert client.get("/api/dormitories/1/outflow?from=2026-10-01&to=2026-10-31").status_code == 401
    password = register_user(client, email="outflow@example.com")["password"]
    assert (
        client.post(
            "/api/auth/login", json={"email": "outflow@example.com", "password": password}
        ).status_code
        == 200
    )
    first = client.post(
        "/api/dormitories", json={"name": "Северное", "client_name": "Клиент"}
    ).json()["id"]
    second = client.post(
        "/api/dormitories", json={"name": "Южное", "client_name": "Клиент"}
    ).json()["id"]
    base = f"/api/dormitories/{first}/outflow"
    created = client.post(base)
    assert created.status_code == 201, created.text
    row_id = created.json()["id"]
    assert created.json()["departure_date"] is None
    assert client.get(f"{base}?from=2026-10-01&to=2026-10-31").json()[0]["id"] == row_id
    updated = client.patch(
        f"{base}/{row_id}",
        json={
            "departure_date": "2026-10-15",
            "personnel_number": "123",
            "full_name": "Иванов Иван",
            "shift_start": "2026-09-01",
            "reason": "Завершил вахту",
            "notes": "Примечание",
            "additional_info": "Дополнительная информация",
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["reason"] == "Завершил вахту"
    assert client.patch(f"{base}/{row_id}", json={"unknown": "x"}).status_code == 422
    assert (
        client.get(f"{base}?from=2026-10-01&to=2026-10-31").json()[0]["additional_info"]
        == "Дополнительная информация"
    )
    assert client.get(f"{base}?from=2026-11-01&to=2026-11-30").json() == []
    assert (
        client.get(f"/api/dormitories/{second}/outflow?from=2026-10-01&to=2026-10-31").json() == []
    )
    assert (
        client.patch(f"/api/dormitories/{second}/outflow/{row_id}", json={"notes": "x"}).status_code
        == 404
    )
    assert client.delete(f"{base}/{row_id}").status_code == 204
    assert client.get(f"{base}?from=2026-10-01&to=2026-10-31").json() == []
