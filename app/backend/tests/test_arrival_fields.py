"""Общие настройки организации, личные значения и защита сохранённых заездов."""

from copy import deepcopy
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.audit import mask
from app.models.arrival_plan import ArrivalPlan
from tests.conftest import add_colleague, login, sign_in
from tests.test_reports import create_dormitory

API = "/api/personnel/arrivals"


def config(client: TestClient) -> dict[str, Any]:
    response = client.get(f"{API}/settings")
    assert response.status_code == 200, response.text
    return response.json()


def save_config(client: TestClient, settings: dict[str, Any]) -> Any:
    return client.put(
        f"{API}/settings", json={key: settings[key] for key in ("revision", "fields", "display")}
    )


def body(dormitory_id: int) -> dict[str, Any]:
    return {
        "dormitory_id": dormitory_id,
        "date": "2026-10-27",
        "count": 2,
        "settings_revision": 0,
        "custom_values": {"comment": "Встреча в 09:00", "transfer": False},
        "people": [
            {
                "id": str(uuid4()),
                "full_name": "",
                "custom_values": {"shifts": "15", "workdate": "2026-10-28"},
            },
            {"id": str(uuid4()), "full_name": "Иванов Иван", "custom_values": {"shifts": "30"}},
        ],
    }


def test_saves_independent_person_fields_and_keeps_blank_identity_position(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    payload = body(create_dormitory(client))
    response = client.post(API, json=payload)
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved["names"] == ["Иванов Иван"]
    assert saved["people"] == payload["people"]
    assert saved["custom_values"]["transfer"] is False
    loaded = client.get("/api/personnel").json()
    assert loaded["arrival_plans"] == [saved]
    assert set(loaded["arrival_settings"]["used_fields"]) == {
        "comment",
        "transfer",
        "shifts",
        "workdate",
    }
    payload["people"][0]["custom_values"]["shifts"] = "0"
    changed = client.put(f"{API}/{saved['id']}", json={**payload, "revision": 0})
    assert changed.status_code == 200, changed.text
    assert changed.json()["people"][0]["custom_values"]["shifts"] == "0"
    assert changed.json()["people"][1]["custom_values"]["shifts"] == "30"
    assert client.put(f"{API}/{saved['id']}", json={**payload, "revision": 0}).status_code == 409
    old_client = {
        "dormitory_id": payload["dormitory_id"],
        "date": payload["date"],
        "count": 2,
        "revision": 1,
    }
    assert client.put(f"{API}/{saved['id']}", json=old_client).status_code == 409
    stored = db_session.get(ArrivalPlan, saved["id"])
    assert stored is not None and stored.people is not None
    assert stored.people[0]["custom_values"]["shifts"] == "0"


@pytest.mark.parametrize(
    "field,value",
    [
        ("shifts", "nan"),
        ("shifts", "abc"),
        ("shifts", True),
        ("workdate", "2026-02-30"),
        ("workdate", "20261028"),
        ("unknown", "x"),
        ("transfer", True),
    ],
)
def test_rejects_wrong_person_types_and_scope(
    client: TestClient, db_session: Session, field: str, value: Any
) -> None:
    sign_in(client, db_session)
    payload = body(create_dormitory(client))
    payload["people"][0]["custom_values"] = {field: value}
    response = client.post(API, json=payload)
    assert response.status_code == 422, response.text


def test_settings_revision_required_fields_and_types_are_checked_on_server(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    payload = body(create_dormitory(client))
    settings = config(client)
    settings["fields"][0]["required"] = True
    changed = save_config(client, settings)
    assert changed.status_code == 200, changed.text
    assert client.post(API, json=payload).status_code == 409
    assert save_config(client, settings).status_code == 409
    payload["settings_revision"] = 1
    payload["people"][1]["custom_values"] = {}
    response = client.post(API, json=payload)
    assert response.status_code == 422
    assert "Человек № 2" in response.json()["detail"]
    payload["people"][1]["custom_values"] = {"shifts": "30"}
    assert client.post(API, json=payload).status_code == 201


def test_removing_field_keeps_metadata_and_values_and_used_types_cannot_change(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    saved = client.post(API, json=body(create_dormitory(client))).json()
    original = config(client)
    settings = deepcopy(original)
    settings["fields"][0]["scope"] = "arrival"
    assert save_config(client, settings).status_code == 409
    settings["fields"][0]["scope"] = "person"
    settings["fields"][0]["type"] = "text"
    assert save_config(client, settings).status_code == 409
    settings = deepcopy(original)
    settings["fields"] = [field for field in settings["fields"] if field["id"] != "shifts"]
    for key in ("order", "visible"):
        settings["display"][key] = [id for id in settings["display"][key] if id != "shifts"]
    removed = save_config(client, settings)
    assert removed.status_code == 200, removed.text
    assert removed.json()["archived_fields"][0]["label"] == "Кол-во смен"
    assert client.get("/api/personnel").json()["arrival_plans"][0] == saved
    payload = {
        key: saved[key]
        for key in ("dormitory_id", "date", "count", "people", "custom_values", "revision")
    }
    payload["settings_revision"] = 1
    payload["people"][1]["full_name"] = "Новое имя"
    response = client.put(f"{API}/{saved['id']}", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["people"][0]["custom_values"]["shifts"] == "15"


def test_settings_are_shared_with_colleagues_and_isolated_between_organizations(
    client: TestClient, db_session: Session
) -> None:
    owner = sign_in(client, db_session)
    payload = body(create_dormitory(client))
    plan = client.post(API, json=payload).json()
    settings = config(client)
    settings["display"]["visible"] = ["names"]
    saved = save_config(client, settings).json()
    assert owner.active_organization_id is not None
    colleague = add_colleague(db_session, owner.active_organization_id)
    assert login(client, colleague.email).status_code == 200
    assert config(client) == saved
    assert client.get("/api/personnel").json()["arrival_plans"][0]["id"] == plan["id"]
    sign_in(client, db_session, email="other-organization@example.com")
    assert config(client)["revision"] == 0
    assert client.get("/api/personnel").json()["arrival_plans"] == []
    assert client.delete(f"{API}/{plan['id']}?revision=0").status_code == 404
    assert client.put(f"{API}/{plan['id']}", json={**payload, "revision": 0}).status_code == 404
    assert client.post(API, json=payload).status_code == 404


def test_duplicate_people_incorrect_count_unknown_settings_and_used_options_rejected(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    payload = body(create_dormitory(client))
    invalid = deepcopy(payload)
    invalid["people"][1]["id"] = invalid["people"][0]["id"]
    assert client.post(API, json=invalid).status_code == 422
    invalid = {**payload, "count": 3}
    assert client.post(API, json=invalid).status_code == 422
    settings = config(client)
    settings["organization_id"] = 999
    assert client.put(f"{API}/settings", json=settings).status_code == 422
    payload["custom_values"]["transport"] = "Автобус"
    assert client.post(API, json=payload).status_code == 201
    settings = config(client)
    next(field for field in settings["fields"] if field["id"] == "transport")["options"] = ["Поезд"]
    assert save_config(client, settings).status_code == 409


def test_audit_masks_arrival_names_and_arbitrary_custom_values() -> None:
    data = {
        "names": ["Секретное Имя"],
        "people": [
            {"full_name": "Секретное Имя", "custom_values": {"arbitrary-id": "Личный текст"}}
        ],
    }
    masked = str(mask(data))
    assert "Секретное" not in masked
    assert "Личный текст" not in masked


def test_legacy_names_get_stable_rows_and_are_preserved_on_first_new_save(
    client: TestClient, db_session: Session
) -> None:
    from datetime import date

    sign_in(client, db_session)
    dorm = create_dormitory(client)
    legacy = ArrivalPlan(
        dormitory_id=dorm, date=date(2026, 10, 27), count=3, names=["Первый", "Второй"], revision=7
    )
    db_session.add(legacy)
    db_session.commit()
    first = client.get("/api/personnel").json()["arrival_plans"][0]
    second = client.get("/api/personnel").json()["arrival_plans"][0]
    assert first["people"] == second["people"]
    assert [person["full_name"] for person in first["people"]] == ["Первый", "Второй", ""]
    payload = {
        key: first[key]
        for key in ("dormitory_id", "date", "count", "names", "people", "custom_values", "revision")
    }
    response = client.put(f"{API}/{legacy.id}", json={**payload, "settings_revision": 0})
    assert response.status_code == 200, response.text
    assert response.json()["names"] == ["Первый", "Второй"]
    assert response.json()["revision"] == 8
    db_session.refresh(legacy)
    assert legacy.people == first["people"]
