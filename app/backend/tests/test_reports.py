"""Общие на общежитие строки, посуточные значения и безопасные формулы."""

from fastapi.testclient import TestClient

from app.report_defaults import REQUIRED_REPORT_ROW_NAMES
from tests.conftest import register_user


def sign_in(client: TestClient, email: str = "reports@example.com") -> None:
    password = register_user(client, email=email)["password"]
    assert (
        client.post("/api/auth/login", json={"email": email, "password": password}).status_code
        == 200
    )


def create_dormitory(client: TestClient, name: str = "Северное") -> int:
    response = client.post("/api/dormitories", json={"name": name, "client_name": "Стройкомплект"})
    assert response.status_code == 201
    return response.json()["id"]


def create_row(client: TestClient, base: str, name: str, formula: str | None = None) -> int:
    response = client.post(f"{base}/rows", json={"name": name, "formula": formula})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_report_is_shared_and_formula_fills_each_date(client: TestClient) -> None:
    sign_in(client)
    dormitory_id = create_dormitory(client)
    base = f"/api/dormitories/{dormitory_id}/report"
    residents = create_row(client, base, "Проживающие")
    arrivals = create_row(client, base, "Прибывшие")
    total = create_row(client, base, "Итого", "=[Проживающие]+[Прибывшие]")
    assert (
        client.put(f"{base}/rows/{residents}/cells/2026-10-01", json={"value": "10"}).status_code
        == 204
    )
    assert (
        client.put(f"{base}/rows/{arrivals}/cells/2026-10-01", json={"value": "2"}).status_code
        == 204
    )
    assert (
        client.put(f"{base}/rows/{residents}/cells/2026-10-02", json={"value": "11"}).status_code
        == 204
    )
    assert (
        client.put(f"{base}/rows/{arrivals}/cells/2026-10-02", json={"value": "3"}).status_code
        == 204
    )
    client.post("/api/auth/logout")
    sign_in(client, "colleague@example.com")
    response = client.get(f"{base}?from=2026-10-01&to=2026-10-03")
    assert response.status_code == 200
    rows = response.json()["rows"]
    assert [row["name"] for row in rows] == [
        *REQUIRED_REPORT_ROW_NAMES,
        "Проживающие",
        "Прибывшие",
        "Итого",
    ]
    assert rows[-1]["id"] == total
    assert rows[-1]["values"] == {"2026-10-01": "12", "2026-10-02": "14", "2026-10-03": "0"}
    assert rows[-1]["errors"] == {}
    assert (
        client.put(f"{base}/rows/{total}/cells/2026-10-03", json={"value": "100"}).status_code
        == 409
    )
    assert (
        client.put(f"{base}/rows/{residents}/cells/2026-10-01", json={"value": "12"}).status_code
        == 204
    )
    assert client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"][-1]["values"] == {
        "2026-10-01": "14"
    }


def test_rename_preserves_formula_and_deletion_checks_dependencies(client: TestClient) -> None:
    sign_in(client)
    base = f"/api/dormitories/{create_dormitory(client)}/report"
    source = create_row(client, base, "Выход")
    computed = create_row(client, base, "Двойной выход", "=[Выход]*2")
    renamed = client.patch(f"{base}/rows/{source}", json={"name": "Вышли на работу"})
    assert renamed.status_code == 200
    rows = client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"]
    assert rows[-1]["formula"] == "=[Вышли на работу]*2"
    assert client.delete(f"{base}/rows/{source}").status_code == 409
    assert client.post(f"{base}/rows", json={"name": "вышли на работу"}).status_code == 409
    assert (
        client.patch(f"{base}/rows/{source}", json={"formula": "=[Двойной выход]"}).status_code
        == 422
    )
    assert (
        client.patch(f"{base}/rows/{computed}", json={"formula": "=__import__('os')"}).status_code
        == 422
    )
    assert client.delete(f"{base}/rows/{computed}").status_code == 204
    assert client.delete(f"{base}/rows/{source}").status_code == 204
    assert [
        row["name"] for row in client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"]
    ] == list(REQUIRED_REPORT_ROW_NAMES)


def test_cell_clear_formula_errors_and_dormitory_isolation(client: TestClient) -> None:
    assert client.get("/api/dormitories/1/report?from=2026-10-01&to=2026-10-02").status_code == 401
    sign_in(client)
    first = create_dormitory(client)
    second = create_dormitory(client, "Южное")
    base = f"/api/dormitories/{first}/report"
    source = create_row(client, base, "Делитель")
    computed = create_row(client, base, "Доля", "=10/[Делитель]")
    assert client.get(f"{base}?from=2026-10-02&to=2026-10-01").status_code == 422
    assert client.get(f"{base}?from=2026-10-01&to=2028-10-01").status_code == 422
    assert (
        client.put(f"{base}/rows/{source}/cells/2026-10-01", json={"value": "0"}).status_code == 204
    )
    result = client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"][-1]
    assert result["id"] == computed
    assert result["errors"] == {"2026-10-01": "Деление на ноль"}
    assert (
        client.put(f"{base}/rows/{source}/cells/2026-10-01", json={"value": "текст"}).status_code
        == 204
    )
    result = client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"][-1]
    assert "не число" in result["errors"]["2026-10-01"]
    assert (
        client.put(f"{base}/rows/{source}/cells/2026-10-01", json={"value": None}).status_code
        == 204
    )
    result = client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"]
    assert result[-2]["values"] == {}
    assert result[-1]["errors"] == {"2026-10-01": "Деление на ноль"}
    other = f"/api/dormitories/{second}/report"
    assert [
        row["name"] for row in client.get(f"{other}?from=2026-10-01&to=2026-10-01").json()["rows"]
    ] == list(REQUIRED_REPORT_ROW_NAMES)
    assert (
        client.put(f"{other}/rows/{source}/cells/2026-10-01", json={"value": "1"}).status_code
        == 404
    )


def test_rows_can_be_reordered_and_order_persists(client: TestClient) -> None:
    sign_in(client)
    base = f"/api/dormitories/{create_dormitory(client)}/report"
    first = create_row(client, base, "Первая")
    second = create_row(client, base, "Вторая")
    third = create_row(client, base, "Третья")
    required_first = client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"][0]["id"]
    assert (
        client.patch(f"{base}/rows/{required_first}/move", json={"direction": "up"}).status_code
        == 409
    )
    assert client.patch(f"{base}/rows/{third}/move", json={"direction": "up"}).status_code == 200
    assert [
        row["id"] for row in client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"][3:]
    ] == [first, third, second]
    assert client.patch(f"{base}/rows/{third}/move", json={"direction": "up"}).status_code == 200
    assert [
        row["id"] for row in client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"][3:]
    ] == [third, first, second]
    assert (
        client.patch(f"{base}/rows/{third}/move", json={"direction": "sideways"}).status_code == 422
    )


def test_formula_treats_empty_cells_as_zero(client: TestClient) -> None:
    sign_in(client)
    base = f"/api/dormitories/{create_dormitory(client)}/report"
    residents = create_row(client, base, "Проживающие")
    arrivals = create_row(client, base, "Прибывшие")
    create_row(client, base, "Итого", "=[Проживающие]+[Прибывшие]")
    create_row(client, base, "Двойное итого", "=[Итого]*2")
    assert (
        client.put(f"{base}/rows/{residents}/cells/2026-10-01", json={"value": "12"}).status_code
        == 204
    )
    rows = client.get(f"{base}?from=2026-10-01&to=2026-10-02").json()["rows"]
    assert rows[-2]["values"] == {"2026-10-01": "12", "2026-10-02": "0"}
    assert rows[-1]["values"] == {"2026-10-01": "24", "2026-10-02": "0"}
    assert (
        client.put(f"{base}/rows/{arrivals}/cells/2026-10-01", json={"value": "3"}).status_code
        == 204
    )
    assert client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"][-2]["values"] == {
        "2026-10-01": "15"
    }


def test_required_totals_keep_name_and_formula_but_allow_formula_edit(client: TestClient) -> None:
    sign_in(client)
    base = f"/api/dormitories/{create_dormitory(client)}/report"
    rows = client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"]
    total_id = rows[0]["id"]
    assert client.delete(f"{base}/rows/{total_id}").status_code == 409
    assert client.patch(f"{base}/rows/{total_id}", json={"name": "Другое"}).status_code == 409
    assert client.patch(f"{base}/rows/{total_id}", json={"formula": None}).status_code == 409
    assert (
        client.put(f"{base}/rows/{total_id}/cells/2026-10-01", json={"value": "3"}).status_code
        == 409
    )
    assert (
        client.post(f"{base}/rows", json={"name": "выход итого", "formula": "=5"}).status_code
        == 409
    )
    source_id = create_row(client, base, "Выход")
    assert client.patch(f"{base}/rows/{total_id}", json={"formula": "=[Выход]"}).status_code == 200
    assert (
        client.put(f"{base}/rows/{source_id}/cells/2026-10-01", json={"value": "7"}).status_code
        == 204
    )
    updated = client.get(f"{base}?from=2026-10-01&to=2026-10-01").json()["rows"][0]
    assert updated["name"] == "Выход Итого"
    assert updated["values"] == {"2026-10-01": "7"}
