"""Списки аванса и расчёта сохраняются отдельно."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.payment import PaymentEntry
from tests.conftest import register_user


def test_advance_and_settlement_rows(client: TestClient) -> None:
    assert client.get("/api/dormitories/1/payments/advance").status_code == 401
    password = register_user(client, email="payments@example.com")["password"]
    assert (
        client.post(
            "/api/auth/login", json={"email": "payments@example.com", "password": password}
        ).status_code
        == 200
    )
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


@pytest.mark.parametrize("kind", ["advance", "settlement"])
def test_clear_payments_scopes_all_rows_and_keeps_columns(
    client: TestClient, db_session: Session, kind: str
) -> None:
    assert client.delete(f"/api/dormitories/1/payments/{kind}").status_code == 401
    password = register_user(client, email="clear-payments@example.com")["password"]
    client.post(
        "/api/auth/login", json={"email": "clear-payments@example.com", "password": password}
    )
    dormitory_ids = [
        client.post("/api/dormitories", json={"name": name, "client_name": "Клиент"}).json()["id"]
        for name in ("Северное", "Южное")
    ]
    base = f"/api/dormitories/{dormitory_ids[0]}/payments"
    other_kind = "settlement" if kind == "advance" else "advance"
    for day in ("2026-09-15", "2026-10-15", None):
        row_id = client.post(f"{base}/{kind}").json()["id"]
        if kind == "settlement":
            assert (
                client.patch(f"{base}/{kind}/{row_id}", json={"settlement_date": day}).status_code
                == 200
            )
    kept_ids = {
        client.post(f"{base}/{other_kind}").json()["id"],
        client.post(f"/api/dormitories/{dormitory_ids[1]}/payments/advance").json()["id"],
        client.post(f"/api/dormitories/{dormitory_ids[1]}/payments/settlement").json()["id"],
    }
    columns_url = f"/api/dormitories/{dormitory_ids[0]}/tables/{kind}/columns"
    assert client.post(columns_url, json={"name": "Комментарий", "kind": "text"}).status_code == 201
    columns = client.get(columns_url).json()
    if kind == "settlement":
        assert len(client.get(f"{base}/{kind}?from=2026-10-01&to=2026-10-31").json()) == 2

    assert client.delete(f"{base}/{kind}").status_code == 204
    assert set(db_session.scalars(select(PaymentEntry.id))) == kept_ids
    assert client.get(columns_url).json() == columns
    assert client.delete(f"{base}/{kind}").status_code == 204
    assert client.delete(f"{base}/invalid").status_code == 422
    assert client.delete(f"/api/dormitories/999999/payments/{kind}").status_code == 404
    assert set(db_session.scalars(select(PaymentEntry.id))) == kept_ids
