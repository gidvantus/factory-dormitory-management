"""Кэш чтения дашборда (issue #242).

Обработчик `GET /api/dashboard` читает один и тот же отчёт, строки таблиц и
размещение персонала по нескольку раз — на каждое общежитие и каждый блок.
Поэтому здесь три проверки: ответ на общей фикстуре совпадает с замороженным
эталоном, число SQL на этой фикстуре не превышает закреплённый потолок, а
`commit` делает кэш невидимым для следующих чтений.

Замер идёт на SQLite юнит-прогона, поэтому потолок — число из этого прогона, а
не из события стенда. Сравнивать его с продакшеном нельзя: там другой драйвер и
другой объём данных.
"""

import json
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import report_readiness, sql_diagnostics
from app.api.dashboard import read_dashboard
from app.models.custom_tab import CustomTab, CustomTabEntry
from app.models.dashboard_block import DashboardBlock
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel, HostelCell
from app.models.organization import OrganizationMember
from app.models.report import ReportCell, ReportRow
from app.models.table_column import TableColumn
from tests.conftest import sign_in

# Часы заморожены: эталон не должен меняться от дня прогона.
TODAY = date(2026, 10, 9)
DAYS = [date(2026, 10, day) for day in (1, 2, 3)]
DASHBOARD_URL = "/api/dashboard?from=2026-10-01&to=2026-10-03"

# Потолок числа SQL на фикстуре `build_fixture`. Числа — из прогона этой же
# фикстуры на SQLite: до кэша чтения было 45 SQL, после стало 41. Прирост
# небольшой, потому что основную долю здесь дают чтения столбцов таблиц
# (`ensure_columns`), которые по условию задачи не кэшируются. Потолок оставлен
# с запасом в три запроса, чтобы тест не падал от безобидного нового чтения в
# соседнем шаге дашборда, но и не пропускал возврат к прежнему числу.
SQL_BEFORE = 45
SQL_AFTER = 41
SQL_CEILING = 44

# Ответ `GET /api/dashboard` на фикстуре `build_fixture`, снятый с прогона после
# перевода чтений на кэш. Эталон заморожен целиком: смена любого поля, значения
# или порядка обязана падать здесь, а не проходить незамеченной. Отдельный файл,
# а не литерал, — чтобы правку данных было видно в диффе как правку данных.
REFERENCE = json.loads(
    (Path(__file__).parent / "fixtures" / "dashboard_read_cache.json").read_text(encoding="utf-8")
)


@pytest.fixture(autouse=True)
def clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(report_readiness, "today_moscow", lambda: TODAY)


def build_fixture(db: Session, organization_id: int) -> list[dict[str, Any]]:
    """Два общежития, три дня и все четыре вида блоков.

    В отчёт каждого общежития входят строки со связями: одна считается по
    размещению персонала, другая — по пользовательской таблице. Так фикстура
    проходит и через сами блоки, и через вложенные чтения `read_report`.
    """
    result: list[dict[str, Any]] = []
    for index, name in enumerate(("Северное", "Южное"), start=1):
        dorm = Dormitory(name=name, client_name="Клиент", organization_id=organization_id)
        db.add(dorm)
        db.flush()

        for position, (metric_key, label) in enumerate(
            [
                ("attendance", "Выход Итого"),
                ("residents", "Проживает Итого"),
                ("turnover", "Текучка Итого"),
            ],
            start=1,
        ):
            row = ReportRow(
                dormitory_id=dorm.id, name=label, metric_key=metric_key, position=position
            )
            db.add(row)
            db.flush()
            for day in DAYS:
                db.add(
                    ReportCell(
                        row_id=row.id,
                        report_date=day,
                        value=str(index * 10 + day.day),
                    )
                )

        tab = CustomTab(
            dormitory_id=dorm.id, name="Статистика", table_created=True, is_active=False
        )
        db.add(tab)
        db.flush()
        columns = [
            TableColumn(
                dormitory_id=dorm.id,
                table_key=tab.table_key,
                name=label,
                kind=kind,
                position=position,
                options=[{"id": "option", "label": "Причина", "archived": False}]
                if kind == "select"
                else [],
            )
            for position, (label, kind) in enumerate(
                [("Причина", "select"), ("Сумма", "number"), ("Дата", "date")]
            )
        ]
        db.add_all(columns)
        db.flush()
        for offset, day in enumerate(DAYS, start=1):
            db.add(
                CustomTabEntry(
                    dormitory_id=dorm.id,
                    tab_id=tab.id,
                    created_at=datetime(2026, 10, 1, tzinfo=UTC),
                    custom_values={
                        str(columns[0].id): "option",
                        str(columns[1].id): str(index + offset),
                        str(columns[2].id): day.isoformat(),
                    },
                )
            )

        hostel = Hostel(
            dormitory_id=dorm.id,
            name="Корпус",
            active_from_month=date(2026, 10, 1),
            # Ручные значения хостела действуют до начала учёта: без явной даты
            # эталон зависел бы от дня прогона.
            occupancy_since=date(2027, 1, 1),
        )
        db.add(hostel)
        db.flush()
        for day in DAYS:
            for field, value in [
                ("paid_m", 10 + day.day),
                ("paid_f", 20 + day.day),
                ("residents_m", index),
                ("residents_f", index + 1),
            ]:
                db.add(
                    HostelCell(
                        hostel_id=hostel.id, report_date=day, field=field, value=value
                    )
                )

        place_row = ReportRow(
            dormitory_id=dorm.id,
            name="Свободных мест",
            position=10,
            link={"table_key": "places", "metric": "free_total"},
        )
        table_row = ReportRow(
            dormitory_id=dorm.id,
            name="Из таблицы",
            position=11,
            link={
                "table_key": tab.table_key,
                "column_id": columns[1].id,
                "operator": "not_empty",
                "date_column_id": columns[2].id,
            },
        )
        db.add_all([place_row, table_row])
        db.flush()
        result.append(
            {
                "dormitory_id": dorm.id,
                "row_id": place_row.id,
                "table_key": tab.table_key,
                "value_column_id": columns[1].id,
                "date_column_id": columns[2].id,
            }
        )
    db.commit()
    return result


def block(sources: list[dict[str, Any]], name: str, **changes: Any) -> dict[str, Any]:
    config: dict[str, Any] = {
        "name": name,
        "display": "number",
        "source_kind": sources[0]["kind"],
        "operation": "sum",
        "period": "range",
        "grouping": "dormitory",
        "all_dormitories": False,
        "sources": sources,
    }
    config.update(changes)
    return config


def add_blocks(db: Session, organization_id: int, fixture: list[dict[str, Any]]) -> None:
    report_sources = [
        {"kind": "report", "dormitory_id": item["dormitory_id"], "row_id": item["row_id"]}
        for item in fixture
    ]
    table_sources = [
        {
            "kind": "table",
            "dormitory_id": item["dormitory_id"],
            "table_key": item["table_key"],
            "value_column_id": item["value_column_id"],
            "date_column_id": item["date_column_id"],
        }
        for item in fixture
    ]
    place_sources = [
        {"kind": "places", "dormitory_id": item["dormitory_id"], "metric": "free_total"}
        for item in fixture
    ]
    db.add_all(
        [
            DashboardBlock(
                organization_id=organization_id,
                config=block(report_sources, "Отчёт числом"),
            ),
            DashboardBlock(
                organization_id=organization_id,
                config=block(report_sources, "Отчёт графиком", display="chart"),
            ),
            DashboardBlock(
                organization_id=organization_id,
                config=block(table_sources, "Таблица"),
            ),
            DashboardBlock(
                organization_id=organization_id,
                config=block(place_sources, "Размещение"),
            ),
        ]
    )
    db.commit()


def prepare(client: TestClient, db_session: Session) -> list[dict[str, Any]]:
    user = sign_in(client, db_session)
    assert user.active_organization_id is not None
    fixture = build_fixture(db_session, user.active_organization_id)
    add_blocks(db_session, user.active_organization_id, fixture)
    return fixture


def count_sql(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> int:
    """Сколько SQL выполнил один `GET /api/dashboard`.

    Считает сам `sql_diagnostics`: его middleware уже висит на приложении и
    учитывает SQL только внутри запроса. Слушатель на движке здесь не годится:
    движок в юнит-прогоне общий, и в счётчик попадали бы запросы фоновых задач
    соседних тестов, а `ContextVar`, выставленный в тесте, не виден потоку
    TestClient.
    """
    counted: list[int] = []
    original = sql_diagnostics.report

    def capture(*args: Any, **kwargs: Any) -> None:
        request_sql = args[1]
        counted.append(request_sql.count)
        original(*args, **kwargs)

    monkeypatch.setattr(sql_diagnostics, "report", capture)
    response = client.get(DASHBOARD_URL)
    assert response.status_code == 200, response.text
    assert len(counted) == 1, "диагностика должна увидеть ровно один запрос"
    return counted[0]


def test_dashboard_response_matches_the_frozen_reference(
    client: TestClient, db_session: Session
) -> None:
    prepare(client, db_session)
    result = client.get(DASHBOARD_URL)
    assert result.status_code == 200, result.text
    assert result.json() == REFERENCE, json.dumps(result.json(), ensure_ascii=False, indent=2)


def test_dashboard_sql_count_stays_under_the_ceiling(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    prepare(client, db_session)
    count = count_sql(client, monkeypatch)
    assert count <= SQL_CEILING, (
        f"SQL: {count}, потолок: {SQL_CEILING} (до: {SQL_BEFORE}, после: {SQL_AFTER})"
    )
    assert SQL_CEILING < SQL_BEFORE


def test_commit_clears_the_cache_and_shows_the_new_value(
    client: TestClient, db_session: Session
) -> None:
    from app import read_cache

    prepare(client, db_session)
    before = client.get(DASHBOARD_URL).json()
    assert read_cache.INFO_KEY in db_session.info

    row = db_session.scalar(
        select(ReportRow).where(
            ReportRow.dormitory_id == int(before["dormitories"][0]["id"]),
            ReportRow.metric_key == "attendance",
        )
    )
    assert row is not None
    cell = db_session.scalar(
        select(ReportCell).where(
            ReportCell.row_id == row.id,
            ReportCell.report_date == DAYS[-1],
        )
    )
    assert cell is not None
    assert cell.value == "13"
    cell.value = "99"
    db_session.commit()

    # Сброс висит на `after_commit`: сессия юнит-прогона живёт дольше запроса.
    assert read_cache.INFO_KEY not in db_session.info
    after = client.get(DASHBOARD_URL).json()
    assert after["totals"]["attendance"] == before["totals"]["attendance"] + 86
    assert after["widgets"] == before["widgets"]


def test_dashboard_route_marks_read_stages(client: TestClient, db_session: Session) -> None:
    user = sign_in(client, db_session)
    assert user.active_organization_id is not None
    fixture = build_fixture(db_session, user.active_organization_id)
    add_blocks(db_session, user.active_organization_id, fixture)
    membership = db_session.scalars(
        select(OrganizationMember).where(
            OrganizationMember.organization_id == user.active_organization_id
        )
    ).first()
    assert membership is not None

    token = sql_diagnostics.start_request("probe")
    try:
        read_dashboard(user, membership, db_session, DAYS[0], DAYS[-1])
    finally:
        request_sql = sql_diagnostics.current()
        sql_diagnostics.finish_request(token)

    assert request_sql is not None
    assert {"readiness", "reports", "layout", "widgets"} <= set(request_sql.stages_ms)
