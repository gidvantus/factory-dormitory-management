"""Диагностика принадлежности: считает невидимые данные и ничего не меняет.

Проверяется то, ради чего команда существует: код выхода, точные `id` и суммы,
названные причины по корневым объектам, совпадение `--json` с текстом и — главное
— отсутствие изменений в базе после прогона. Юнит-прогон идёт на SQLite: команде
хватает схемы, собранной из моделей, а копия настоящей базы проверяется на стенде.
"""

import json
from collections.abc import Iterator
from datetime import date
from typing import Any

import pytest
from sqlalchemy import MetaData, create_engine, insert, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import db as db_module
from app.diagnostics import ownership
from app.models import Base
from app.models.custom_tab import CustomTab
from app.models.dashboard_block import DashboardBlock
from app.models.dormitory import Dormitory
from app.models.dormitory_template import DormitoryTemplate
from app.models.hostel import Hostel, HostelCell
from app.models.organization import Organization
from app.models.report_template import ReportTemplate
from app.models.resident import Resident
from app.models.statistics_report import StatisticsReport
from tests.conftest import create_user

# Автор, которого в базе нет: так выглядит «автор удалён».
DELETED_USER_ID = 2147483647

# Общежития в тестах заводятся с явными `id`: отчёт печатает точные номера, а
# Core-вставка возвращает их в непротипизированном `inserted_primary_key`.
ORPHAN_DORMITORY_ID = 1
SECOND_DORMITORY_ID = 2


def table_snapshot() -> dict[str, list[tuple[Any, ...]]]:
    """Снимок всех таблиц: команда не имеет права изменить ни одну строку.

    Своя сессия на каждый снимок: снимок «до» не должен держать транзакцию,
    пока работает сама команда.
    """
    session = db_module.SessionLocal()
    try:
        return {
            table.name: sorted((tuple(row) for row in session.execute(select(table))), key=repr)
            for table in Base.metadata.sorted_tables
        }
    finally:
        session.close()


@pytest.fixture
def orphan_engine(monkeypatch: pytest.MonkeyPatch) -> Iterator[Engine]:
    """Схема, в которой `dormitories.organization_id` ещё nullable.

    Так выглядит копия базы, на которой `0043` остановилась с перечнем сирот:
    `NOT NULL` не ставится, а общежитие без организации остаётся в таблице. В
    модели колонка обязательна, поэтому схема собирается из копии метаданных с
    ослабленным ограничением — сами модели при этом не меняются, и тест
    проверяет именно тот случай, ради которого раздел «станет невидимым» и нужен.
    """
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        table.to_metadata(metadata)
    metadata.tables["dormitories"].c.organization_id.nullable = True
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    metadata.create_all(engine)
    monkeypatch.setattr(
        db_module,
        "SessionLocal",
        sessionmaker(bind=engine, autoflush=False, expire_on_commit=False),
    )
    try:
        yield engine
    finally:
        metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture
def orphan_session(orphan_engine: Engine) -> Iterator[Session]:
    factory = sessionmaker(bind=orphan_engine, autoflush=False, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()


def add_orphan_dormitory(
    session: Session,
    *,
    dormitory_id: int = ORPHAN_DORMITORY_ID,
    created_by_id: int | None = None,
) -> int:
    """Общежитие без организации.

    Вставка идёт Core-запросом намеренно: `before_flush` в `tests/conftest.py`
    привязывает общежитие к организации автоматически, а проверить надо именно
    осиротевшую строку.
    """
    session.execute(
        insert(Dormitory).values(
            id=dormitory_id,
            name="Южное",
            client_name="Клиент",
            organization_id=None,
            created_by_id=created_by_id,
        )
    )
    session.commit()
    return dormitory_id


def test_empty_base_exits_ok_with_zero_totals(
    db_session: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    """База без сирот: итог напечатан, код выхода `0`."""
    assert ownership.main([]) == ownership.EXIT_OK

    captured = capsys.readouterr()
    assert "Станет невидимым после включения изоляции:" in captured.out
    assert "  нет" in captured.out
    assert "видимо: 0 общежитий, 0 проживающих" in captured.out
    assert "станет невидимым: 0 общежитий, 0 проживающих, 0 корневых объектов" in captured.out
    assert captured.err == ""


def test_orphan_dormitory_reports_exact_ids_and_sums(
    orphan_session: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    """Общежитие без организации: код `2`, точный `id` и суммы по нему."""
    author = create_user(orphan_session, email="orphan-author@example.com")
    dormitory_id = add_orphan_dormitory(orphan_session, created_by_id=author.id)
    hostel = Hostel(
        dormitory_id=dormitory_id,
        name="Корпус 1",
        active_from_month=date(2026, 1, 1),
    )
    orphan_session.add(hostel)
    orphan_session.flush()
    orphan_session.add_all(
        [
            Resident(dormitory_id=dormitory_id, full_name="Иванов Иван Иванович"),
            HostelCell(hostel_id=hostel.id, report_date=date(2026, 1, 2), field="beds", value=4),
        ]
    )
    orphan_session.commit()

    assert ownership.main([]) == ownership.EXIT_INVISIBLE

    output = capsys.readouterr().out
    assert f"id={dormitory_id} «Южное» (создал: {author.id})" in output
    assert "проживающих 1, мест 1" in output
    assert "станет невидимым: 1 общежитий, 1 проживающих, 0 корневых объектов" in output


def test_root_objects_name_every_reason(
    db_session: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    """Корневые объекты без организации: обе причины названы, `id` на месте."""
    author = create_user(db_session, email="no-organization@example.com")
    db_session.add_all(
        [
            ReportTemplate(name="Без автора", created_by_id=None),
            ReportTemplate(name="Автор удалён", created_by_id=DELETED_USER_ID),
            DormitoryTemplate(name="Автор без организации", snapshot={}, created_by_id=author.id),
            DashboardBlock(config={"name": "Блок без автора"}, created_by_id=None),
        ]
    )
    db_session.commit()

    assert ownership.main(["--json"]) == ownership.EXIT_INVISIBLE

    payload = json.loads(capsys.readouterr().out)
    root_objects = payload["invisible"]["root_objects"]
    assert {item["table"] for item in root_objects} == {
        "report_templates",
        "dormitory_templates",
        "dashboard_blocks",
    }
    reasons = {item["name"]: item["reason"] for item in root_objects}
    assert reasons == {
        "Без автора": ownership.REASON_NO_AUTHOR,
        "Автор удалён": ownership.REASON_AUTHOR_DELETED,
        "Автор без организации": ownership.REASON_NO_ORGANIZATION,
        "Блок без автора": ownership.REASON_NO_AUTHOR,
    }
    deleted = next(item for item in root_objects if item["name"] == "Автор удалён")
    assert deleted["created_by_id"] == DELETED_USER_ID
    assert payload["totals"]["invisible"]["root_objects"] == 4


def test_json_report_has_same_numbers_as_text(
    orphan_session: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--json` — тот же отчёт: числа организаций и итог совпадают с текстом."""
    owner = create_user(orphan_session, email="owner@example.com")
    organization = Organization(name="Ромашка")
    orphan_session.add(organization)
    orphan_session.flush()
    dormitory = Dormitory(
        name="Северное",
        client_name="Клиент",
        organization_id=organization.id,
        created_by_id=owner.id,
    )
    orphan_session.add(dormitory)
    orphan_session.flush()
    hostel = Hostel(dormitory_id=dormitory.id, name="Корпус", active_from_month=date(2026, 1, 1))
    orphan_session.add(hostel)
    orphan_session.flush()
    orphan_session.add_all(
        [
            Resident(dormitory_id=dormitory.id, full_name="Петров Пётр"),
            HostelCell(hostel_id=hostel.id, report_date=date(2026, 1, 2), field="beds", value=3),
            CustomTab(dormitory_id=dormitory.id, name="Своя вкладка"),
            StatisticsReport(organization_id=organization.id, name="Общий", visibility="shared"),
            StatisticsReport(organization_id=organization.id, name="Личный", visibility="personal"),
            ReportTemplate(organization_id=organization.id, name="Шаблон отчёта"),
            DormitoryTemplate(organization_id=organization.id, name="Снимок", snapshot={}),
            DashboardBlock(organization_id=organization.id, config={"name": "Блок"}),
        ]
    )
    orphan_session.commit()
    add_orphan_dormitory(orphan_session, dormitory_id=SECOND_DORMITORY_ID)

    text_code = ownership.main([])
    text_output = capsys.readouterr().out
    json_code = ownership.main(["--json"])
    payload = json.loads(capsys.readouterr().out)

    assert text_code == json_code == ownership.EXIT_INVISIBLE
    assert "общежитий: 1, проживающих: 1, мест: 1, вкладок: 1" in text_output
    assert "отчётов статистики: 2 (personal: 1, shared: 1)" in text_output
    assert "станет невидимым: 1 общежитий, 0 проживающих, 0 корневых объектов" in text_output

    assert payload["totals"] == {
        "visible": {"dormitories": 1, "residents": 1},
        "invisible": {"dormitories": 1, "residents": 0, "root_objects": 0},
    }
    assert len(payload["organizations"]) == 1
    counts = payload["organizations"][0]["counts"]
    assert counts[ownership.DORMITORIES] == 1
    assert counts[ownership.RESIDENTS] == 1
    assert counts[ownership.HOSTEL_CELLS] == 1
    assert counts[ownership.CUSTOM_TABS] == 1
    assert counts[ownership.DORMITORY_TEMPLATES] == 1
    assert counts[ownership.REPORT_TEMPLATES] == 1
    assert counts[ownership.STATISTICS_REPORTS_PERSONAL] == 1
    assert counts[ownership.STATISTICS_REPORTS_SHARED] == 1
    assert counts[ownership.DASHBOARD_BLOCKS] == 1


def test_report_changes_no_table(
    orphan_session: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    """Прогон ничего не пишет: снимок всех таблиц до и после совпадает."""
    owner = create_user(orphan_session, email="snapshot@example.com")
    organization = Organization(name="Ромашка")
    orphan_session.add(organization)
    orphan_session.flush()
    orphan_session.add(
        Dormitory(
            name="Северное",
            client_name="Клиент",
            organization_id=organization.id,
            created_by_id=owner.id,
        )
    )
    orphan_session.add(ReportTemplate(name="Без автора", created_by_id=None))
    orphan_session.commit()
    add_orphan_dormitory(orphan_session, dormitory_id=SECOND_DORMITORY_ID)

    before = table_snapshot()
    assert ownership.main([]) == ownership.EXIT_INVISIBLE
    capsys.readouterr()
    after = table_snapshot()

    assert after == before


def test_base_without_isolation_migration_is_reported(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Копия базы без T3: код `1` и понятный текст вместо трейсбека."""
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE dormitories "
                "(id INTEGER PRIMARY KEY, name VARCHAR, created_by_id INTEGER, "
                "organization_id INTEGER)"
            )
        )
        # У шаблонов структуры колонки ещё нет — ровно то, что даёт база до `0045`.
        for table in ("report_templates", "statistics_reports", "dashboard_blocks"):
            connection.execute(
                text(
                    f"CREATE TABLE {table} "
                    "(id INTEGER PRIMARY KEY, name VARCHAR, created_by_id INTEGER, "
                    "organization_id INTEGER)"
                )
            )
        connection.execute(
            text(
                "CREATE TABLE dormitory_templates "
                "(id INTEGER PRIMARY KEY, name VARCHAR, created_by_id INTEGER)"
            )
        )
    monkeypatch.setattr(
        db_module,
        "SessionLocal",
        sessionmaker(bind=engine, autoflush=False, expire_on_commit=False),
    )
    try:
        assert ownership.main([]) == ownership.EXIT_ERROR
        captured = capsys.readouterr()
        assert captured.out == ""
        assert (
            "сначала примените миграцию: в таблице dormitory_templates "
            "нет колонки organization_id" in captured.err
        )
    finally:
        engine.dispose()


def test_base_without_any_table_is_reported(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Пустая база без миграций: код `1`, и названо, чего не хватает."""
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    monkeypatch.setattr(
        db_module,
        "SessionLocal",
        sessionmaker(bind=engine, autoflush=False, expire_on_commit=False),
    )
    try:
        assert ownership.main([]) == ownership.EXIT_ERROR
        assert (
            "сначала примените миграцию: в базе нет таблицы dormitories" in capsys.readouterr().err
        )
    finally:
        engine.dispose()


@pytest.mark.parametrize("argv", [["--json"], []])
def test_report_is_printable_in_both_formats(
    db_session: Session, capsys: pytest.CaptureFixture[str], argv: list[str]
) -> None:
    """Оба формата печатаются на пустой базе: отчёт всегда читается человеком."""
    assert ownership.main(argv) == ownership.EXIT_OK
    assert capsys.readouterr().out.strip()
