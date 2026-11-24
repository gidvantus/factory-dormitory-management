"""Соответствия по идентификаторам применяются во всех действиях переноса."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.outflow import PersonnelOutflow
from app.models.resident import Resident
from tests.conftest import sign_in
from tests.test_reports import create_dormitory


@pytest.mark.parametrize(
    ("source", "target", "action"),
    [
        ("residents", "outflow", "outflow"),
        ("residents", "advance", "payments/advance"),
        ("residents", "settlement", "payments/settlement"),
        ("residents", "residents", "transfer"),
        ("inflow", "residents", "settle"),
        ("inflow", "outflow", "outflow"),
    ],
)
def test_saved_mapping_copies_renamed_name(
    client: TestClient, db_session: Session, source: str, target: str, action: str
) -> None:
    sign_in(client, db_session)
    dorm = create_dormitory(client)
    destination = create_dormitory(client, "Новое общежитие") if action == "transfer" else dorm
    url = f"/api/dormitories/{dorm}"
    source_columns = f"{url}/tables/{source}/columns"
    target_columns = f"/api/dormitories/{destination}/tables/{target}/columns"
    source_id = next(
        col["id"] for col in client.get(source_columns).json() if col["builtin_key"] == "full_name"
    )
    target_id = next(
        col["id"] for col in client.get(target_columns).json() if col["builtin_key"] == "full_name"
    )
    assert (
        client.patch(
            f"{source_columns}/{source_id}", json={"name": "Фамилия Имя Отчество", "kind": "text"}
        ).status_code
        == 200
    )
    row = client.post(f"{url}/{source}").json()["id"]
    name = "Иванов Иван Иванович"
    edit_url = f"{url}/{source}/{row}"
    if source == "residents":
        edit_url += "?month=2026-11-01"
    saved = client.patch(edit_url, json={"full_name": name})
    assert saved.status_code == 200, saved.text

    movement = f"{url}/{source}/{row}/{action}"
    mapping_url = f"{url}/settings/transfer-columns?source={source}&target={target}"
    body = {}
    if action == "transfer":
        mapping_url += f"&target_dormitory_id={destination}"
        body = {"target_dormitory_id": destination, "month": "2026-11-01"}
    payment = action.startswith("payments/")
    initial = client.post(
        movement if payment else movement + "/preview",
        json={"check_columns": True} if payment else body,
    )
    assert initial.status_code == 200, initial.text
    choice = next(
        item for item in initial.json()["column_choices"] if item["source"]["id"] == source_id
    )
    assert {"id": target_id, "name": "ФИО"} in choice["targets"]
    assert (
        client.put(mapping_url, json={"mappings": {str(source_id): source_id}}).status_code == 422
    )
    assert (
        client.put(mapping_url, json={"mappings": {str(source_id): target_id}}).status_code == 204
    )
    assert (
        client.patch(
            f"{target_columns}/{target_id}", json={"name": "Полное имя", "kind": "text"}
        ).status_code
        == 200
    )
    settings = client.get(mapping_url).json()
    assert (
        next(item for item in settings if item["source"]["id"] == source_id)["target_id"]
        == target_id
    )

    if payment:
        written = client.post(movement, json={"check_columns": True})
        assert written.status_code == 201, written.text
        assert written.json()["payment"]["full_name"] == name
    else:
        latest = client.post(movement + "/preview", json=body)
        assert latest.status_code == 200, latest.text
        assert not any(
            item["source"]["id"] == source_id for item in latest.json()["column_choices"]
        )
        confirmation = {**body, "preview_token": latest.json()["preview_token"]}
        if source == "residents":
            confirmation["confirm_loss"] = True
        elif action == "outflow":
            confirmation.update(reason="Не заехал", departure_date="2026-11-24")
        written = client.post(movement, json=confirmation)
        assert written.status_code == (200 if action == "transfer" else 201), written.text
        if source == "inflow":
            db_session.expire_all()
            model = Resident if target == "residents" else PersonnelOutflow
            result = db_session.get(model, written.json()["row_id"])
            assert isinstance(result, (Resident, PersonnelOutflow)) and result.full_name == name
        else:
            assert written.json()["full_name"] == name

    assert client.put(mapping_url, json={"mappings": {str(source_id): None}}).status_code == 204
    cleared = client.get(mapping_url).json()
    assert next(item for item in cleared if item["source"]["id"] == source_id)["target_id"] is None
