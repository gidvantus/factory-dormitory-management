"""Приток персонала: сохранение, фильтр и удаление."""

from fastapi.testclient import TestClient

from tests.conftest import register_user


def test_inflow_rows_are_persistent_filtered_and_isolated(client: TestClient) -> None:
    assert client.get("/api/dormitories/1/inflow?from=2026-10-01&to=2026-10-31").status_code == 401
    password = register_user(client, email="inflow@example.com")["password"]
    assert (
        client.post(
            "/api/auth/login", json={"email": "inflow@example.com", "password": password}
        ).status_code
        == 200
    )
    first = client.post(
        "/api/dormitories", json={"name": "Северное", "client_name": "Клиент"}
    ).json()["id"]
    second = client.post(
        "/api/dormitories", json={"name": "Южное", "client_name": "Клиент"}
    ).json()["id"]
    base = f"/api/dormitories/{first}/inflow"
    created = client.post(base)
    assert created.status_code == 201, created.text
    row_id = created.json()["id"]
    assert created.json()["settlement_date"] is None
    assert (
        client.patch(
            f"{base}/{row_id}",
            json={
                "settlement_date": "2026-10-07",
                "personnel_number": "123",
                "full_name": "Иванов Иван",
                "citizenship": "Россия",
                "notes": "Первая вахта",
                "shift_count": 10,
            },
        ).status_code
        == 200
    )
    assert client.patch(f"{base}/{row_id}", json={"shift_count": -1}).status_code == 422
    assert client.patch(f"{base}/{row_id}", json={"shift_count": "текст"}).status_code == 422
    assert (
        client.get(f"{base}?from=2026-10-01&to=2026-10-31").json()[0]["full_name"] == "Иванов Иван"
    )
    assert client.get(f"{base}?from=2026-11-01&to=2026-11-30").json() == []
    assert (
        client.get(f"/api/dormitories/{second}/inflow?from=2026-10-01&to=2026-10-31").json() == []
    )
    assert (
        client.patch(f"/api/dormitories/{second}/inflow/{row_id}", json={"notes": "x"}).status_code
        == 404
    )
    assert client.delete(f"{base}/{row_id}").status_code == 204
    assert client.get(f"{base}?from=2026-10-01&to=2026-10-31").json() == []
