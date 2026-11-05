"""Сводный отчёт: общие показатели, отдельные клиенты, пропуски и доступ."""

from datetime import date
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.report import ReportCell, ReportRow
from tests.conftest import sign_in


def setup_report(
    db: Session, name: str, row_name: str, values: list[str | None]
) -> tuple[int, int]:
    dorm = Dormitory(name=name, client_name="Общий клиент")
    db.add(dorm)
    db.flush()
    row = ReportRow(dormitory_id=dorm.id, name=row_name, position=20)
    db.add(row)
    db.flush()
    for index, value in enumerate(values, 1):
        if value is not None:
            db.add(ReportCell(row_id=row.id, report_date=date(2026, 10, index), value=value))
    db.commit()
    return dorm.id, row.id


def payload(dorm: int, row: int) -> dict[str, Any]:
    return {
        "name": "Большой отчёт",
        "display": "summary",
        "source_kind": "report",
        "period": "range",
        "sources": [],
        "all_dormitories": True,
        "summary": {
            "view": "daily",
            "label": "client",
            "dormitory_ids": [],
            "metrics": [
                {
                    "name": "Выход",
                    "aggregate": "sum",
                    "sources": [{"kind": "report", "dormitory_id": dorm, "row_id": row}],
                }
            ],
        },
    }


def test_summary_same_client_auto_match_aggregates_and_missing(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm, row = setup_report(db_session, "Северное", "Выход", ["2", "4"])
    setup_report(db_session, "Южное", "  ВЫХОД  ", ["3", "7"])
    setup_report(db_session, "Западное", "Другой показатель", ["9", "9"])
    config = payload(dorm, row)
    url = "/api/dashboard/preview?from=2026-10-01&to=2026-10-02"
    for operation, expected in [("sum", [6, 10]), ("average", [3, 5]), ("last", [4, 7])]:
        config["summary"]["metrics"][0]["aggregate"] = operation
        response = client.post(url, json=config)
        assert response.status_code == 200, response.text
        result = response.json()
        rows = result["summary"]["rows"]
        assert [row["value"] for row in rows] == [*expected, None]
        assert [row["label"] for row in rows[:2]] == [
            "Общий клиент (Северное)",
            "Общий клиент (Южное)",
        ]
        assert rows[0]["daily"] == [
            {"date": "2026-10-01", "value": 2},
            {"date": "2026-10-02", "value": 4},
        ]
        assert len(result["errors"]) == 1
    config["all_dormitories"] = False
    config["summary"]["dormitory_ids"] = [dorm]
    # Сохранённый ID продолжает работать после переименования строки.
    db_session.get(ReportRow, row).name = "Выход переименован"  # type: ignore[union-attr]
    db_session.commit()
    saved = client.post("/api/dashboard/blocks", json={"revision": 0, "config": config})
    assert saved.status_code == 201, saved.text
    dashboard = client.get("/api/dashboard?from=2026-10-01&to=2026-10-02")
    assert dashboard.status_code == 200, dashboard.text
    assert len(dashboard.json()["widgets"][0]["summary"]["rows"]) == 1
    assert dashboard.json()["widgets"][0]["summary"]["rows"][0]["value"] == 4


def test_summary_no_partial_totals_and_full_31_or_32_dates(
    client: TestClient, db_session: Session
) -> None:
    sign_in(client, db_session)
    dorm, row = setup_report(db_session, "Северное", "Выход", ["2", None])
    config = payload(dorm, row)
    for end, count in [("2026-10-31", 31), ("2026-11-01", 32)]:
        response = client.post(f"/api/dashboard/preview?from=2026-10-01&to={end}", json=config)
        assert response.status_code == 200, response.text
        result = response.json()["summary"]
        assert len(result["dates"]) == count
        assert len(result["rows"][0]["daily"]) == count
        assert result["rows"][0]["value"] is None
        assert result["rows"][0]["daily"][1]["value"] is None


def test_summary_foreign_dormitory_is_rejected(client: TestClient, db_session: Session) -> None:
    owner = sign_in(client, db_session)
    dorm, row = setup_report(db_session, "Чужое", "Выход", ["2", "4"])
    # Переключаем владельца, оставляя источник в первой организации.
    sign_in(client, db_session, email="summary-other@example.com")
    assert owner.active_organization_id is not None
    response = client.post(
        "/api/dashboard/preview?from=2026-10-01&to=2026-10-02", json=payload(dorm, row)
    )
    assert response.status_code == 404
