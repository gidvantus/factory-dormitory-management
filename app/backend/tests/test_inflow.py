"""Приток персонала: сохранение, фильтр и удаление."""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.inflow import PersonnelInflow
from tests.conftest import sign_in


def test_inflow_rows_are_persistent_filtered_and_isolated(
    client: TestClient, db_session: Session
) -> None:
    assert client.get("/api/dormitories/1/inflow?from=2026-10-01&to=2026-10-31").status_code == 401
    sign_in(client, db_session, email="inflow@example.com")
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


def test_inflow_page_search_sort_and_manual_order_cover_all_rows(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm = client.post(
        "/api/dormitories", json={"name": "Северное", "client_name": "Клиент"}
    ).json()["id"]
    base = f"/api/dormitories/{dorm}"
    first = PersonnelInflow(dormitory_id=dorm, full_name="Иванов Иван", shift_count=1)
    others = [
        PersonnelInflow(dormitory_id=dorm, full_name=f"Петров {index}", shift_count=index + 2)
        for index in range(103)
    ]
    db_session.add_all([first, *others])
    db_session.commit()
    period = {"from": "2026-11-01", "to": "2026-11-30"}
    initial = client.get(f"{base}/inflow", params={**period, "page": 1}).json()
    assert initial["total"] == 104
    assert len(initial["rows"]) == 100
    assert initial["rows"][0]["id"] == others[-1].id
    second = client.get(f"{base}/inflow", params={**period, "page": 2}).json()
    assert [row["id"] for row in second["rows"]] == [
        others[2].id,
        others[1].id,
        others[0].id,
        first.id,
    ]
    match = client.get(f"{base}/inflow", params={**period, "page": 1, "q": "иВАНОВ иван"}).json()
    assert [row["id"] for row in match["rows"]] == [first.id]

    columns = client.get(f"{base}/tables/inflow/columns").json()
    shift_column = next(column for column in columns if column["builtin_key"] == "shift_count")
    ascending = client.get(
        f"{base}/inflow", params={**period, "page": 1, "sort_column": shift_column["id"]}
    ).json()
    assert ascending["rows"][0]["id"] == first.id
    assert ascending["rows"][-1]["shift_count"] == 100

    reordered = client.put(
        f"{base}/table-views/inflow",
        json={
            "revision": 0,
            "state": {},
            "row_move": {"source": first.id, "target": others[2].id, "after": False},
        },
    )
    assert reordered.status_code == 200, reordered.text
    first_page = client.get(f"{base}/inflow", params={**period, "page": 1}).json()
    assert [row["id"] for row in first_page["rows"]] == [row["id"] for row in initial["rows"]]
    second_page = client.get(f"{base}/inflow", params={**period, "page": 2}).json()
    assert second_page["rows"][0]["id"] == first.id
