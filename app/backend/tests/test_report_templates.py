"""Снимки структуры отчёта не копируют значения и не связаны с источником."""

from fastapi.testclient import TestClient

from tests.conftest import register_user


def sign_in(client: TestClient) -> None:
    password = register_user(client, email="templates@example.com")["password"]
    assert (
        client.post(
            "/api/auth/login", json={"email": "templates@example.com", "password": password}
        ).status_code
        == 200
    )


def create_dormitory(client: TestClient, name: str, template_id: int | None = None) -> int:
    payload: dict[str, str | int] = {"name": name, "client_name": "Клиент"}
    if template_id is not None:
        payload["template_id"] = template_id
    response = client.post("/api/dormitories", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_template_copies_only_structure_and_remains_independent(client: TestClient) -> None:
    sign_in(client)
    source_id = create_dormitory(client, "Исходное")
    source = f"/api/dormitories/{source_id}/report"
    residents = client.post(f"{source}/rows", json={"name": "Проживающие"}).json()["id"]
    arrivals = client.post(f"{source}/rows", json={"name": "Прибывшие"}).json()["id"]
    client.post(f"{source}/rows", json={"name": "Всего", "formula": "=[Проживающие]+[Прибывшие]"})
    assert (
        client.patch(f"{source}/rows/{arrivals}/move", json={"direction": "up"}).status_code == 200
    )
    assert (
        client.put(f"{source}/rows/{residents}/cells/2026-10-01", json={"value": "17"}).status_code
        == 204
    )

    created = client.post(
        "/api/report-templates", json={"name": "Стандарт", "dormitory_id": source_id}
    )
    assert created.status_code == 201, created.text
    template_id = created.json()["id"]
    assert created.json()["row_count"] == 3
    assert [item["name"] for item in client.get("/api/report-templates").json()] == ["Стандарт"]

    # Изменение источника после сохранения не переписывает снимок.
    assert (
        client.patch(f"{source}/rows/{residents}", json={"name": "Теперь другое"}).status_code
        == 200
    )
    target_id = create_dormitory(client, "Новое", template_id)
    target = f"/api/dormitories/{target_id}/report"
    rows = client.get(f"{target}?from=2026-10-01&to=2026-10-01").json()["rows"]
    assert [row["name"] for row in rows] == ["Прибывшие", "Проживающие", "Всего"]
    assert rows[2]["formula"] == "=[Проживающие]+[Прибывшие]"
    assert rows[0]["values"] == rows[1]["values"] == {}
    assert rows[2]["values"] == {"2026-10-01": "0"}

    assert client.delete(f"/api/report-templates/{template_id}").status_code == 204
    assert client.get("/api/report-templates").json() == []
    assert (
        client.get(f"{target}?from=2026-10-01&to=2026-10-01").json()["rows"][2]["formula"]
        == "=[Проживающие]+[Прибывшие]"
    )


def test_template_validation_and_missing_reference(client: TestClient) -> None:
    assert client.get("/api/report-templates").status_code == 401
    sign_in(client)
    source_id = create_dormitory(client, "Пустое")
    assert (
        client.post(
            "/api/report-templates", json={"name": "Пустой", "dormitory_id": source_id}
        ).status_code
        == 422
    )
    assert (
        client.post("/api/report-templates", json={"name": "Нет", "dormitory_id": 999}).status_code
        == 404
    )
    client.post(f"/api/dormitories/{source_id}/report/rows", json={"name": "Выход"})
    assert (
        client.post(
            "/api/report-templates", json={"name": "Стандарт", "dormitory_id": source_id}
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/report-templates", json={"name": "стандарт", "dormitory_id": source_id}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/dormitories", json={"name": "Новое", "client_name": "Клиент", "template_id": 999}
        ).status_code
        == 404
    )
    assert [item["name"] for item in client.get("/api/dormitories").json()] == ["Пустое"]
