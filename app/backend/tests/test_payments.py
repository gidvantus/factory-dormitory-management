"""Списки аванса и расчёта сохраняются отдельно."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.conftest import sign_in


def test_advance_and_settlement_rows(client: TestClient, db_session: Session) -> None:
    assert client.get("/api/dormitories/1/payments/advance").status_code == 401
    sign_in(client, db_session, email="payments@example.com")
    dormitory = client.post(
        "/api/dormitories", json={"name": "Северное", "client_name": "Клиент"}
    ).json()["id"]
    base = f"/api/dormitories/{dormitory}/payments"

    advance = client.post(f"{base}/advance")
    assert advance.status_code == 201, advance.text
    advance_id = advance.json()["id"]
    saved = client.patch(
        f"{base}/advance/{advance_id}",
        json={"personnel_number": "123", "full_name": "Иванов Иван", "advance_amount": "1250.50"},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["advance_amount"] == "1250.50"
    assert (
        client.patch(f"{base}/advance/{advance_id}", json={"advance_amount": "-1"}).status_code
        == 422
    )
    assert (
        client.patch(f"{base}/advance/{advance_id}", json={"advance_amount": "1.234"}).status_code
        == 422
    )
    assert (
        client.patch(
            f"{base}/advance/{advance_id}", json={"settlement_date": "2026-10-10"}
        ).status_code
        == 422
    )
    assert client.get(f"{base}/advance").json()[0]["full_name"] == "Иванов Иван"

    settlement = client.post(f"{base}/settlement")
    assert settlement.status_code == 201, settlement.text
    settlement_id = settlement.json()["id"]
    assert (
        client.get(f"{base}/settlement?from=2026-10-01&to=2026-10-31").json()[0]["id"]
        == settlement_id
    )
    assert (
        client.patch(
            f"{base}/settlement/{settlement_id}",
            json={
                "personnel_number": "124",
                "full_name": "Петров Пётр",
                "settlement_date": "2026-10-15",
            },
        ).status_code
        == 200
    )
    assert (
        client.patch(f"{base}/settlement/{settlement_id}", json={"advance_amount": "5"}).status_code
        == 422
    )
    assert client.get(f"{base}/settlement?from=2026-11-01&to=2026-11-30").json() == []
    assert client.get(f"{base}/settlement").status_code == 422
    assert client.delete(f"{base}/advance/{settlement_id}").status_code == 404
    assert client.delete(f"{base}/advance/{advance_id}").status_code == 204
    assert client.get(f"{base}/advance").json() == []
