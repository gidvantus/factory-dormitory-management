"""Связи с локальными вкладками и дневными показателями мест, включая шаблоны."""

from datetime import UTC, datetime
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTabEntry
from tests.conftest import sign_in


def dormitory(client: TestClient, name: str = "Северное", **extra: Any) -> int:
    response = client.post(
        "/api/dormitories", json={"name": name, "client_name": "Клиент", **extra}
    )
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def custom_table(client: TestClient, dorm: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    tab = client.post(f"/api/dormitories/{dorm}/tabs", json={"name": "Документы"}).json()
    response = client.post(
        f"/api/dormitories/{dorm}/tabs/{tab['id']}/table",
        json={
            "columns": [
                {
                    "name": "Статус",
                    "kind": "select",
                    "options": [{"label": "Готов"}, {"label": "Ожидает"}],
                },
                {"name": "Дата события", "kind": "date"},
            ]
        },
    )
    assert response.status_code == 201, response.text
    columns = client.get(f"/api/dormitories/{dorm}/tables/{tab['table_key']}/columns").json()
    return tab, columns


def report_row(client: TestClient, dorm: int, name: str, link: dict[str, Any]) -> dict[str, Any]:
    response = client.post(
        f"/api/dormitories/{dorm}/report/rows", json={"name": name, "link": link}
    )
    assert response.status_code == 201, response.text
    return dict(response.json())


def report(
    client: TestClient, dorm: int, start: str = "2026-10-08", end: str = "2026-10-09"
) -> dict[str, Any]:
    response = client.get(f"/api/dormitories/{dorm}/report?from={start}&to={end}")
    assert response.status_code == 200, response.text
    return {row["name"]: row for row in response.json()["rows"]}


def put_custom(
    client: TestClient, dorm: int, tab: dict[str, Any], row: int, column: int, value: Any
) -> None:
    assert (
        client.put(
            f"/api/dormitories/{dorm}/tables/{tab['table_key']}/rows/{row}/cells/{column}",
            json={"value": value},
        ).status_code
        == 200
    )


def test_custom_sources_count_dates_update_and_keep_dormitory_scope(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = dormitory(client)
    tab, columns = custom_table(client, dorm)
    status, event = columns[:2]
    ready, waiting = [option["id"] for option in status["options"]]
    rows = []
    for choice, day in [
        (ready, "2026-10-08"),
        (ready, "2026-10-08"),
        (ready, "2026-10-09"),
        (waiting, "2026-10-09"),
        (ready, None),
    ]:
        row = client.post(f"/api/dormitories/{dorm}/tabs/{tab['id']}/rows").json()["id"]
        rows.append(row)
        put_custom(client, dorm, tab, row, status["id"], choice)
        if day:
            put_custom(client, dorm, tab, row, event["id"], day)
        record = db_session.get(CustomTabEntry, row)
        assert record is not None
        record.created_at = datetime(2026, 10, 8, 21, 30, tzinfo=UTC)
    db_session.commit()
    link = {
        "table_key": tab["table_key"],
        "column_id": status["id"],
        "value": ready,
        "date_column_id": event["id"],
    }
    linked = report_row(client, dorm, "Готовы", link)
    report_row(client, dorm, "Созданы", {**link, "date_column_id": None})
    report_row(
        client,
        dorm,
        "С датой",
        {
            "table_key": tab["table_key"],
            "column_id": event["id"],
            "operator": "not_empty",
            "date_column_id": event["id"],
        },
    )
    assert (
        client.post(
            f"/api/dormitories/{dorm}/report/rows",
            json={"name": "Дважды", "formula": "=[Готовы]*2"},
        ).status_code
        == 201
    )
    values = report(client, dorm)
    assert values["Готовы"]["values"] == {"2026-10-08": "2", "2026-10-09": "1"}
    assert values["Созданы"]["values"] == {"2026-10-08": "0", "2026-10-09": "4"}
    assert values["С датой"]["values"] == {"2026-10-08": "2", "2026-10-09": "2"}
    assert values["Дважды"]["values"]["2026-10-08"] == "4"
    assert (
        client.put(
            f"/api/dormitories/{dorm}/report/rows/{linked['id']}/cells/2026-10-08",
            json={"value": "99"},
        ).status_code
        == 409
    )
    assert (
        client.delete(
            f"/api/dormitories/{dorm}/tables/{tab['table_key']}/columns/{status['id']}"
        ).status_code
        == 409
    )
    other = dormitory(client, "Южное")
    assert (
        client.post(
            f"/api/dormitories/{other}/report/rows", json={"name": "Чужие", "link": link}
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/dormitories/{dorm}/report/rows",
            json={"name": "Чужой столбец", "link": {**link, "table_key": "archive"}},
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/dormitories/{dorm}/tabs/{tab['id']}/rows/{rows[0]}").status_code == 204
    )
    put_custom(client, dorm, tab, rows[1], status["id"], waiting)
    assert report(client, dorm)["Готовы"]["values"] == {"2026-10-08": "0", "2026-10-09": "1"}


def hostel(client: TestClient, dorm: int, name: str, month: str = "2026-10-01") -> int:
    response = client.post(f"/api/dormitories/{dorm}/hostels", json={"name": name, "month": month})
    assert response.status_code == 201, response.text
    return int(response.json()["id"])


def place(
    client: TestClient, dorm: int, hostel_id: int, day: str, field: str, value: int | None
) -> None:
    assert (
        client.put(
            f"/api/dormitories/{dorm}/hostels/{hostel_id}/cells/{day}/{field}",
            json={"value": value},
        ).status_code
        == 204
    )


def test_places_links_match_all_metrics_and_activity_periods(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = dormitory(client)
    first, second = hostel(client, dorm, "Первый"), hostel(client, dorm, "Второй")
    future = hostel(client, dorm, "Будущий", "2026-11-01")
    for field, value in {"paid_m": 10, "paid_f": 4, "residents_m": 12, "residents_f": 1}.items():
        place(client, dorm, first, "2026-10-08", field, value)
    place(client, dorm, second, "2026-10-08", "paid_m", 3)
    place(client, dorm, second, "2026-10-09", "residents_f", 2)
    metrics = [
        "residents_m",
        "residents_f",
        "residents_total",
        "paid_m",
        "paid_f",
        "paid_total",
        "free_m",
        "free_f",
        "free_total",
    ]
    for metric in metrics:
        report_row(
            client, dorm, metric, {"table_key": "places", "hostel_id": first, "metric": metric}
        )
    report_row(client, dorm, "Все", {"table_key": "places", "metric": "free_total"})
    report_row(
        client,
        dorm,
        "Будущий",
        {"table_key": "places", "hostel_id": future, "metric": "paid_total"},
    )
    source = client.get(f"/api/dormitories/{dorm}/hostels?from=2026-10-08&to=2026-10-09").json()[
        "months"
    ][0]["hostels"][0]["values"]
    values = report(client, dorm)
    for metric in metrics:
        assert values[metric]["values"] == {
            day: str(source[metric].get(day, 0)) for day in ("2026-10-08", "2026-10-09")
        }
        assert values[metric]["errors"] == {}
    assert values["free_m"]["values"]["2026-10-08"] == "-2"
    assert values["Все"]["values"] == {"2026-10-08": "4", "2026-10-09": "-2"}
    assert values["Будущий"]["values"]["2026-10-08"] == "0"
    place(client, dorm, first, "2026-10-08", "paid_m", None)
    assert report(client, dorm)["paid_m"]["values"]["2026-10-08"] == "0"
    place(client, dorm, first, "2026-11-01", "paid_m", 99)
    assert (
        client.delete(f"/api/dormitories/{dorm}/hostels/{first}?month=2026-11-01").status_code
        == 204
    )
    november = report(client, dorm, "2026-11-01", "2026-11-01")
    assert november["paid_m"]["values"] == {"2026-11-01": "0"}
    assert report(client, dorm)["residents_m"]["values"]["2026-10-08"] == "12"
    assert len(client.get(f"/api/dormitories/{dorm}/hostels/sources").json()) == 3


def test_places_link_validation_and_scope(client: TestClient, db_session: Session) -> None:
    assert client.get("/api/dormitories/1/hostels/sources").status_code == 401
    sign_in(client, db_session)
    first, second = dormitory(client), dormitory(client, "Другое")
    foreign = hostel(client, second, "Чужой")
    base = f"/api/dormitories/{first}/report/rows"
    assert client.get(f"/api/dormitories/{first}/hostels/sources").json() == []
    assert (
        client.post(
            base,
            json={
                "name": "Чужой",
                "link": {"table_key": "places", "hostel_id": foreign, "metric": "paid_m"},
            },
        ).status_code
        == 404
    )
    for link in [
        {"table_key": "places"},
        {"table_key": "places", "metric": "unknown"},
        {"table_key": "places", "metric": "paid_m", "column_id": 1},
        {"table_key": "custom_0", "column_id": 1},
    ]:
        assert client.post(base, json={"name": "Ошибка", "link": link}).status_code == 422
    report_row(client, first, "Пусто", {"table_key": "places", "metric": "paid_total"})
    assert report(client, first)["Пусто"]["values"]["2026-10-08"] == "0"


def test_report_template_restores_custom_and_places_sources_once_without_values(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    source = dormitory(client)
    tab, columns = custom_table(client, source)
    status, event = columns[:2]
    ready = status["options"][0]["id"]
    custom_link = {
        "table_key": tab["table_key"],
        "column_id": status["id"],
        "value": ready,
        "date_column_id": event["id"],
    }
    report_row(client, source, "Документы готовы", custom_link)
    report_row(client, source, "Ещё документы", custom_link)
    first = hostel(client, source, "Северный корпус")
    report_row(
        client,
        source,
        "Оплачено",
        {"table_key": "places", "hostel_id": first, "metric": "paid_total"},
    )
    report_row(
        client,
        source,
        "Свободно",
        {"table_key": "places", "hostel_id": first, "metric": "free_total"},
    )
    report_row(client, source, "Все корпуса", {"table_key": "places", "metric": "residents_total"})
    place(client, source, first, "2026-10-08", "paid_m", 25)
    row = client.post(f"/api/dormitories/{source}/tabs/{tab['id']}/rows").json()["id"]
    put_custom(client, source, tab, row, status["id"], ready)
    put_custom(client, source, tab, row, event["id"], "2026-10-08")
    template = client.post(
        "/api/report-templates", json={"name": "Все источники", "dormitory_id": source}
    )
    assert template.status_code == 201, template.text
    # The saved snapshot survives later source edits.
    assert (
        client.patch(
            f"/api/dormitories/{source}/tables/{tab['table_key']}/columns/{status['id']}",
            json={"name": "Изменённый статус", "kind": "select", "options": status["options"]},
        ).status_code
        == 200
    )
    target = dormitory(client, "Копия", template_id=template.json()["id"])
    copied_tabs = client.get(f"/api/dormitories/{target}/tabs").json()
    assert len(copied_tabs) == 1
    copied_tab = copied_tabs[0]
    assert copied_tab["name"] == "Документы" and copied_tab["table_created"]
    copied = report(client, target)
    assert (
        copied["Документы готовы"]["link"]["table_key"]
        == copied_tab["table_key"]
        != tab["table_key"]
    )
    assert copied["Документы готовы"]["link"] == copied["Ещё документы"]["link"]
    assert copied["Документы готовы"]["link"]["column_id"] != status["id"]
    assert copied["Документы готовы"]["link"]["date_column_id"] != event["id"]
    copied_columns = client.get(
        f"/api/dormitories/{target}/tables/{copied_tab['table_key']}/columns"
    ).json()
    assert [column["name"] for column in copied_columns] == ["Статус", "Дата события", "Удалить"]
    assert copied_columns[0]["options"] == status["options"]
    assert client.get(f"/api/dormitories/{target}/tabs/{copied_tab['id']}/rows").json() == []
    copied_hostels = client.get(f"/api/dormitories/{target}/hostels/sources").json()
    assert len(copied_hostels) == 1 and copied_hostels[0]["id"] != first
    assert (
        copied["Оплачено"]["link"]["hostel_id"]
        == copied["Свободно"]["link"]["hostel_id"]
        == copied_hostels[0]["id"]
    )
    for name in ("Документы готовы", "Ещё документы", "Оплачено", "Свободно", "Все корпуса"):
        assert copied[name]["errors"] == {}
        assert copied[name]["values"] == {"2026-10-08": "0", "2026-10-09": "0"}
    new_row = client.post(f"/api/dormitories/{target}/tabs/{copied_tab['id']}/rows").json()["id"]
    put_custom(client, target, copied_tab, new_row, copied_columns[0]["id"], ready)
    put_custom(client, target, copied_tab, new_row, copied_columns[1]["id"], "2026-10-09")
    place(client, target, copied_hostels[0]["id"], "2026-10-09", "paid_f", 8)
    assert report(client, target)["Документы готовы"]["values"]["2026-10-09"] == "1"
    assert report(client, target)["Оплачено"]["values"]["2026-10-09"] == "8"
    assert report(client, source)["Документы готовы"]["values"]["2026-10-09"] == "0"
    assert report(client, source)["Оплачено"]["values"]["2026-10-08"] == "25"
