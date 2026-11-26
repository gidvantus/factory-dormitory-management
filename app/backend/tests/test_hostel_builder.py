from datetime import date
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import hostel_occupancy
from app.models.hostel import Hostel
from app.models.personnel import EmployeeEvent
from app.models.resident import Resident
from tests.conftest import sign_in
from tests.test_inflow_entry import form, payload, settle
from tests.test_reports import create_dormitory
from tests.test_table_exchange import filled, upload, workbook_rows


def test_layout_keeps_history_and_updates_existing_report_link(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = f"/api/dormitories/{create_dormitory(client)}"
    base = dorm + "/hostels"
    month = "2025-11-01"
    hostel_id = client.post(base, json={"name": "Корпус", "month": "2025-10-01"}).json()["id"]
    days = ["2025-10-31", month]
    for day in days:
        for key, value in (("residents_m", 7), ("residents_f", 2), ("paid_m", 12)):
            response = client.put(f"{base}/{hostel_id}/cells/{day}/{key}", json={"value": value})
            assert response.status_code == 204
    report = client.post(
        f"{dorm}/report/rows",
        json={
            "name": "Сумма из размещения",
            "link": {"table_key": "places", "metric": "residents_total", "hostel_id": hostel_id},
        },
    )
    assert report.status_code == 201
    rows = client.get(f"{base}/settings?month={month}").json()["hostels"][0]["rows"]
    for row in rows:
        if row["key"] == "residents_m":
            row["name"] = "Мужчин"
        if row["key"] == "residents_total":
            row["formula"] = "=[Мужчин]+[Проживает Ж]+1"
        if row["formula"]:
            row["formula"] = row["formula"].replace("[Проживает М]", "[Мужчин]")
    payload = {"name": "Корпус", "month": month, "version": 0, "rows": rows}
    settings = f"{base}/{hostel_id}/settings"
    updated = client.put(settings, json=payload)
    assert updated.status_code == 204, updated.text
    assert client.put(settings, json=payload).status_code == 409
    output = client.get(f"{dorm}/report?from={days[0]}&to={month}").json()
    assert next(row for row in output["rows"] if row["id"] == report.json()["id"])["values"] == {
        days[0]: "9",
        month: "10",
    }
    rows[-1]["archived"] = True
    assert client.put(settings, json={**payload, "version": 1}).status_code == 204
    rows[-1]["archived"] = False
    response = client.put(settings, json={**payload, "version": 2})
    assert response.status_code == 204, response.text
    current = client.get(f"{base}?from={month}&to={month}").json()["months"][0]["hostels"][0]
    assert current["values"]["paid_total"][month] == 12


def test_live_occupancy_history_and_template_use_local_sources(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    sign_in(client, db_session)
    source, target = (create_dormitory(client, name) for name in ("Северное", "Речное"))
    month, day_1, day_2 = "2025-11-01", "2025-11-10", "2025-11-11"
    base = f"/api/dormitories/{source}/hostels"
    rows = client.get(f"{base}/settings?month={month}").json()["defaults"]
    for row, gender in zip(rows, ("М", "Ж"), strict=False):
        row["link"] = {"table_key": "resident_occupancy", "gender": gender}
    new = client.post(base, json={"name": "Первый", "month": month, "rows": rows})
    assert new.status_code == 201, new.text
    hostel = db_session.get(Hostel, new.json()["id"])
    assert hostel is not None
    hostel.occupancy_since = date.fromisoformat(day_1)
    monkeypatch.setattr(hostel_occupancy, "occupancy_today", lambda: date.fromisoformat(day_1))
    resident = Resident(dormitory_id=source, hostel_id=hostel.id, gender="М")
    db_session.add(resident)
    db_session.commit()
    monkeypatch.setattr(hostel_occupancy, "occupancy_today", lambda: date.fromisoformat(day_2))
    resident.gender = "Ж"
    db_session.add(Resident(dormitory_id=source, hostel_id=hostel.id, gender="М"))
    db_session.commit()
    placed = client.get(f"{base}?from={day_1}&to={day_2}").json()["months"][0]["hostels"][0]
    assert placed["values"]["residents_m"] == {day_1: 1, day_2: 1}
    assert placed["values"]["residents_f"] == {day_1: 0, day_2: 1}
    assert placed["values"]["residents_total"] == {day_1: 1, day_2: 2}

    report = f"/api/dormitories/{source}/report/rows"
    source_row = client.post(report, json={"name": "Выход смены"})
    assert source_row.status_code == 201, source_row.text
    rows.append(
        {
            "key": "r_" + "3" * 20,
            "name": "Выход смены",
            "link": {"table_key": "report", "row_id": source_row.json()["id"]},
        }
    )
    template = client.post(base + "/templates", json={"name": "Учёт мест", "rows": rows})
    assert template.status_code == 201, template.text
    template_id = template.json()["id"]
    target_base = f"/api/dormitories/{target}/hostels"
    missing = client.get(f"{target_base}/templates/{template_id}").json()
    assert rows[-1]["key"] in missing["warnings"]
    target_row = client.post(f"/api/dormitories/{target}/report/rows", json={"name": "Выход смены"})
    assert target_row.status_code == 201, target_row.text
    target_rows = client.get(f"{target_base}/templates/{template_id}")
    assert target_rows.status_code == 200, target_rows.text
    assert target_rows.json()["warnings"] == {}
    assert target_rows.json()["rows"][-1]["link"]["row_id"] == target_row.json()["id"]
    created = client.post(
        target_base, json={"name": "Второй", "month": month, "rows": target_rows.json()["rows"]}
    )
    assert created.status_code == 201, created.text
    target_hostel = db_session.get(Hostel, created.json()["id"])
    assert target_hostel is not None
    target_hostel.occupancy_since = date.fromisoformat(day_1)
    db_session.commit()
    values = client.get(f"{target_base}?from={day_2}&to={day_2}").json()["months"][0]["hostels"][0][
        "values"
    ]
    assert values["residents_total"] == {day_2: 0}
    assert values.get("paid_m", {}) == {}

    sign_in(client, db_session, email="outside-hostel-template@example.com")
    foreign = f"/api/dormitories/{create_dormitory(client)}/hostels"
    assert client.get(f"{foreign}/settings?month={month}").json()["templates"] == []
    assert client.get(f"{foreign}/templates/{template_id}").status_code == 404


def test_excel_uses_custom_manual_rows_and_exports_calculated_values(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = f"/api/dormitories/{create_dormitory(client)}"
    month = "2025-11-01"
    manual = "r_" + "1" * 20
    derived = "r_" + "2" * 20
    share = "r_" + "3" * 20
    base = dorm + "/hostels"
    response = client.post(
        base,
        json={
            "name": "Корпус",
            "month": month,
            "rows": [
                {"key": manual, "name": "Лимит"},
                {"key": derived, "name": "Остаток", "formula": "=[Лимит]-5"},
                {"key": share, "name": "Доля остатка", "formula": "=[Остаток]/[Лимит]"},
            ],
        },
    )
    assert response.status_code == 201, response.text
    hostel = response.json()["id"]
    path = dorm + "/data-transfer/places"
    query = f"?from={month}&to={month}"
    template = client.get(path + "/template" + query)
    assert template.status_code == 200, template.text
    assert [row[:2] for row in workbook_rows(template.content)[1:] if row[0]] == [
        ["Корпус", "Лимит"]
    ]
    content = filled(client, path, [["Корпус", "Лимит", 8]], query)
    rows = client.get(f"{base}/settings?month={month}").json()["hostels"][0]["rows"]
    rows[-1]["display_percent"] = True
    changed = client.put(
        f"{base}/{hostel}/settings",
        json={"month": month, "name": "Корпус", "rows": rows, "version": 0},
    )
    assert changed.status_code == 204, changed.text
    result = upload(client, path, content, query)
    assert result.status_code == 200, result.text
    assert upload(client, path, content, query).status_code == 422
    assert (
        client.put(f"{base}/{hostel}/cells/{month}/{derived}", json={"value": 1}).status_code == 422
    )
    exported = client.get(path + "/export" + query)
    assert exported.status_code == 200, exported.text
    assert workbook_rows(exported.content)[1:] == [
        ["Корпус", "Лимит", 8],
        ["Корпус", "Остаток", 3],
        ["Корпус", "Доля остатка", 0.375],
    ]
    sheet = load_workbook(BytesIO(exported.content)).active
    assert sheet is not None and sheet["C4"].number_format == "0.00%"


def test_snapshot_uses_configured_gender_and_custom_options(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    sign_in(client, db_session)
    dorm = f"/api/dormitories/{create_dormitory(client)}"
    residents = dorm + "/residents"
    columns = dorm + "/tables/residents/columns"
    base = dorm + "/hostels"
    month, first, second = "2025-11-01", "2025-11-10", "2025-11-11"
    gender = next(col for col in client.get(columns).json() if col["builtin_key"] == "gender")
    updated = client.patch(
        f"{columns}/{gender['id']}",
        json={
            "name": gender["name"],
            "kind": "select",
            "options": [*gender["options"], {"label": "Не указан"}],
        },
    )
    assert updated.status_code == 200, updated.text
    extra = updated.json()["options"][-1]["id"]
    state = client.post(
        columns,
        json={
            "name": "Статус",
            "kind": "select",
            "options": [{"label": "Активен"}, {"label": "Выехал"}],
        },
    ).json()
    active, inactive = [option["id"] for option in state["options"]]
    rows = [
        {
            "key": key,
            "name": name,
            "link": {
                "table_key": "residents",
                "column_id": col,
                "value": value,
                "scope": "hostel",
                "count_mode": "snapshot",
            },
        }
        for key, name, col, value in (
            ("residents_m", "М", gender["id"], "М"),
            ("residents_f", "Не указан", gender["id"], extra),
            ("r_" + "7" * 20, "Активны", state["id"], active),
        )
    ]
    response = client.post(base, json={"name": "Корпус", "month": month, "rows": rows})
    assert response.status_code == 201, response.text
    hostel = db_session.get(Hostel, response.json()["id"])
    assert hostel
    hostel.occupancy_since = hostel.resident_fields_since = date.fromisoformat(first)
    db_session.commit()

    monkeypatch.setattr(hostel_occupancy, "occupancy_today", lambda: date.fromisoformat(first))
    ident = client.post(residents).json()["id"]
    url = f"{residents}/{ident}?month={month}"
    assert client.patch(url, json={"hostel_id": hostel.id, "gender": "М"}).status_code == 200
    resident = db_session.get(Resident, ident)
    assert resident
    resident.custom_values = {str(state["id"]): active}
    db_session.commit()
    monkeypatch.setattr(hostel_occupancy, "occupancy_today", lambda: date.fromisoformat(second))
    assert client.patch(url, json={"gender": "fake-option"}).status_code == 422
    assert client.patch(url, json={"gender": extra}).status_code == 200
    resident.custom_values = {str(state["id"]): inactive}
    db_session.commit()
    output = client.get(f"{base}?from={first}&to={second}")
    assert output.status_code == 200, output.text
    values = output.json()["months"][0]["hostels"][0]["values"]
    assert values["residents_m"] == {first: 1, second: 0}
    assert values["residents_f"] == {first: 0, second: 1}
    assert values[rows[2]["key"]] == {first: 1, second: 0}


def test_snapshot_backdates_inflow_and_outflow_even_after_hostel_change(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    sign_in(client, db_session)
    dormitory_id = create_dormitory(client)
    dorm = f"/api/dormitories/{dormitory_id}"
    month = "2026-10-01"
    columns = f"{dorm}/tables/residents/columns"
    custom_gender = client.post(
        columns,
        json={
            "name": "Пол по списку",
            "kind": "select",
            "options": [{"label": "М"}, {"label": "Ж"}],
        },
    ).json()
    male, female = (option["id"] for option in custom_gender["options"])
    rows = [
        {
            "key": "residents_m",
            "name": "Проживает М",
            "link": {
                "table_key": "residents",
                "column_id": custom_gender["id"],
                "value": male,
                "scope": "hostel",
                "count_mode": "snapshot",
            },
        },
        {
            "key": "residents_total",
            "name": "Всего проживает",
            "link": {"table_key": "resident_occupancy", "gender": "all"},
        },
    ]
    hostels = []
    for name in ("Квартира", "Корпус"):
        response = client.post(f"{dorm}/hostels", json={"name": name, "month": month, "rows": rows})
        assert response.status_code == 201, response.text
        hostel = db_session.get(Hostel, response.json()["id"])
        assert hostel
        hostel.occupancy_since = hostel.resident_fields_since = date(2026, 10, 19)
        hostels.append(hostel.id)
    first, second = hostels
    db_session.commit()

    def snapshots() -> dict[int, dict[str, dict[str, int]]]:
        result = client.get(f"{dorm}/hostels?from=2026-10-19&to=2026-10-25")
        assert result.status_code == 200, result.text
        return {item["id"]: item["values"] for item in result.json()["months"][0]["hostels"]}

    monkeypatch.setattr(hostel_occupancy, "occupancy_today", lambda: date(2026, 10, 22))
    values = {
        "full_name": "Иванов Иван",
        "hostel_id": first,
        str(custom_gender["id"]): male,
    }
    pending = client.post(
        f"{dorm}/inflow/entries", json=payload(client, form(client, dormitory_id), values)
    )
    assert pending.status_code == 201, pending.text
    pending_id = pending.json()["id"]
    inflow = f"{dorm}/inflow/{pending_id}"
    assert client.patch(inflow, json={"settlement_date": "2026-10-20"}).status_code == 200
    assert snapshots()[first]["residents_m"]["2026-10-20"] == 0
    preview = client.post(f"{inflow}/settle/preview")
    assert preview.json()["settlement_date"] == "2026-10-20"
    ident = settle(client, dormitory_id, pending_id)["row_id"]
    after_settlement = {f"2026-10-{day}": int(day >= 20) for day in range(19, 23)}
    assert snapshots()[first] == {
        "residents_m": after_settlement,
        "residents_total": after_settlement,
    }

    monkeypatch.setattr(hostel_occupancy, "occupancy_today", lambda: date(2026, 10, 24))
    resident = f"{dorm}/residents/{ident}"
    assert client.patch(f"{resident}?month={month}", json={"hostel_id": second}).status_code == 200
    assert (
        client.put(
            f"{dorm}/tables/residents/rows/{ident}/cells/{custom_gender['id']}",
            json={"value": female},
        ).status_code
        == 200
    )
    assert snapshots()[second]["residents_total"]["2026-10-24"] == 1
    plan = client.post(f"{resident}/outflow/preview")
    assert plan.status_code == 200, plan.text
    result = client.post(
        f"{resident}/outflow",
        json={
            "preview_token": plan.json()["preview_token"],
            "confirm_loss": True,
            "reason": "Окончание вахты",
            "departure_date": "2026-10-23",
        },
    )
    assert result.status_code == 201, result.text

    history = snapshots()
    expected = {f"2026-10-{day}": int(20 <= day < 23) for day in range(19, 25)}
    assert history[first] == {"residents_m": expected, "residents_total": expected}
    empty = dict.fromkeys(expected, 0)
    assert history[second] == {"residents_m": empty, "residents_total": empty}
    event_dates = db_session.execute(
        select(EmployeeEvent.kind, EmployeeEvent.happened_on).where(
            EmployeeEvent.source_table == "residents",
            EmployeeEvent.source_id == ident,
            EmployeeEvent.kind.in_(("arrival", "outflow")),
        )
    ).all()
    assert dict(event_dates) == {"arrival": date(2026, 10, 20), "outflow": date(2026, 10, 23)}
