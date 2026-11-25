"""Диагностика медленных SQL-запросов (issue #231).

Тесты держат три обещания задачи:

* **счёт и время SQL** считаются по каждому HTTP-запросу, независимо от маршрута,
  и не текут между соседними и параллельными запросами;
* **в диагностической записи нет значений** — ни bind-параметров, ни литералов из
  SQL, ни адреса запроса с идентификатором: только шаблон маршрута, счётчики и
  безопасный fingerprint;
* **прежний контракт `/metrics` не изменился** (`tests/test_metrics.py`), а новые
  метрики SQL не заводят меток `request_id` или fingerprint.

Приложение-стенд (`stand`) собирается здесь же: боевые ручки для этих проверок
слишком тяжёлые, а механика одна и та же — middleware приложения и слушатели
SQLAlchemy, зарегистрированные на классе `Engine`.
"""

import json
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from prometheus_client import generate_latest
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from starlette.responses import Response

from app import metrics, sql_diagnostics
from app.diagnostics import sql_fingerprints
from tests.conftest import sign_in

# Значения, которых в диагностической записи быть не должно ни в каком виде.
SECRET_NAME = "Секретова Секрета Секретовна"
SECRET_LITERAL = "СекретныйЛитерал"


def samples(text_body: str, name: str) -> list[tuple[dict[str, str], float]]:
    """Серии одной метрики из текста экспозиции — вместе с их метками."""
    result: list[tuple[dict[str, str], float]] = []
    for line in text_body.splitlines():
        if not line or line.startswith("#"):
            continue
        head, _, raw_value = line.rpartition(" ")
        metric, _, rest = head.partition("{")
        if metric != name:
            continue
        labels_text = rest.rsplit("}", 1)[0] if "{" in head else ""
        labels: dict[str, str] = {}
        for part in labels_text.split(",") if labels_text else []:
            key, _, raw = part.partition("=")
            labels[key.strip()] = raw.strip().strip('"')
        result.append((labels, float(raw_value)))
    return result


def value(text_body: str, name: str, **labels: str) -> float:
    """Значение серии по имени метрики и меткам; отсутствие серии — 0."""
    for sample_labels, sample_value in samples(text_body, name):
        if all(sample_labels.get(key) == expected for key, expected in labels.items()):
            return sample_value
    return 0.0


def exposure(client: TestClient) -> str:
    """Текст `/metrics`: скрейп в учёте SQL не участвует."""
    response = client.get("/metrics")
    assert response.status_code == 200
    return response.text


def events(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    """Разобранные события `slow_sql_request` из перехваченного stdout."""
    captured = capsys.readouterr()
    result: list[dict[str, Any]] = []
    for line in captured.out.splitlines():
        if sql_diagnostics.EVENT_NAME not in line:
            continue
        result.append(json.loads(line))
    return result


def event_lines(capsys: pytest.CaptureFixture[str]) -> list[str]:
    """Сырые строки событий: по ним проверяется отсутствие значений."""
    captured = capsys.readouterr()
    return [line for line in captured.out.splitlines() if sql_diagnostics.EVENT_NAME in line]


def always_slow(monkeypatch: pytest.MonkeyPatch) -> None:
    """Пороги в ноль: событие пишется на каждый запрос, включая пустой по SQL."""
    monkeypatch.setattr(sql_diagnostics, "slow_request_threshold_ms", lambda: 0)
    monkeypatch.setattr(sql_diagnostics, "slow_sql_threshold_ms", lambda: 0)


@pytest.fixture(name="engine")
def engine_fixture() -> Iterator[Engine]:
    """Отдельный движок стенда: слушатели SQLAlchemy глобальны, база — своя.

    `StaticPool` и `check_same_thread=False` — как в `tests/conftest.py`:
    TestClient выполняет ручку в чужом потоке, и однопоточное sqlite-подключение
    иначе рвётся при закрытии.
    """
    created = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    try:
        yield created
    finally:
        created.dispose()


def stand(engine: Engine) -> TestClient:
    """Приложение-стенд: ручки, которые заведомо ходят в базу.

    Путь с параметром (`/api/items/{item_id}`) нужен, чтобы проверить, что в
    запись попадает шаблон маршрута, а не адрес запроса. `/metrics` объявлен по
    тому же пути, что и в боевом приложении: он проверяется на исключение.
    """
    application = FastAPI()
    application.middleware("http")(sql_diagnostics.middleware)

    @application.get("/api/items/{item_id}")
    def item(item_id: int) -> dict[str, int]:
        with Session(engine) as session:
            session.execute(text("SELECT :name AS name"), {"name": SECRET_NAME})
            session.execute(text(f"SELECT '{SECRET_LITERAL}' AS literal"))
            session.execute(text("SELECT count(*) FROM sqlite_master"))
        return {"item_id": item_id}

    @application.get("/api/empty")
    def empty() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/api/staged")
    def staged() -> dict[str, str]:
        """Ручка с размеченными этапами: `assemble` размечен дважды, время копится."""
        with sql_diagnostics.stage("sources"):
            time.sleep(0.03)
        with sql_diagnostics.stage("assemble"):
            time.sleep(0.004)
        with sql_diagnostics.stage("assemble"):
            time.sleep(0.004)
        return {"status": "ok"}

    @application.get("/api/boom")
    def boom() -> dict[str, str]:
        raise RuntimeError("ручка падает")

    @application.get("/metrics", include_in_schema=False)
    def metrics_endpoint() -> Response:
        return metrics.exposition()

    return TestClient(application, raise_server_exceptions=False)


def test_event_fields_are_the_documented_contract(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Набор полей записи заморожен: по нему построены панели и инструкция."""
    always_slow(monkeypatch)

    with stand(engine) as client:
        assert client.get("/api/items/7").status_code == 200

    [event] = events(capsys)
    assert set(event) == {
        "event",
        "ts",
        "request_id",
        "method",
        "route",
        "status",
        "failed",
        "duration_ms",
        "sql_ms",
        "sql_count",
        "sql_share",
        "stages_ms",
        "thresholds",
        "slow_sql",
    }
    assert set(event["thresholds"]) == {"request_ms", "sql_ms"}
    assert set(event["slow_sql"][0]) == {
        "fingerprint",
        "operation",
        "tables",
        "count",
        "total_ms",
        "max_ms",
        "slowest_at_ms",
    }


def test_sql_count_and_time_are_counted_per_request(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Число выполнений и суммарное SQL-время считаются для запроса целиком."""
    always_slow(monkeypatch)

    with stand(engine) as client:
        assert client.get("/api/items/7").status_code == 200

    [event] = events(capsys)
    assert event["route"] == "/api/items/{item_id}"
    assert event["status"] == 200
    assert event["failed"] is False
    assert event["sql_count"] == 3
    assert event["sql_ms"] > 0
    assert 0 < event["sql_share"] <= 1


def test_fast_request_is_not_logged(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Под порогом записи нет: журнала всех запросов задача не заводит."""
    monkeypatch.setattr(sql_diagnostics, "slow_request_threshold_ms", lambda: 60_000)
    monkeypatch.setattr(sql_diagnostics, "slow_sql_threshold_ms", lambda: 0)

    with stand(engine) as client:
        assert client.get("/api/items/7").status_code == 200

    assert events(capsys) == []


def test_event_has_no_values_params_url_or_raw_sql(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Ни bind-параметров, ни литералов, ни адреса запроса, ни сырого SQL."""
    always_slow(monkeypatch)

    with stand(engine) as client:
        assert client.get("/api/items/7").status_code == 200

    [line] = event_lines(capsys)
    event = json.loads(line)
    assert SECRET_NAME not in line
    assert SECRET_LITERAL not in line
    assert "/api/items/7" not in line
    # Сырого SQL нет вовсе: `text()` в проекте собирается f-строками, и литерал
    # в готовом стейтменте уже не отличить от имени колонки. Видны только
    # операция, имена таблиц и отпечаток шаблона.
    assert "SELECT count(*) FROM sqlite_master" not in line
    assert " AS name" not in line
    assert "'" not in line

    assert {entry["fingerprint"] for entry in event["slow_sql"]} == {
        sql_diagnostics.fingerprint("SELECT ? AS name"),
        sql_diagnostics.fingerprint("SELECT ? AS literal"),
        sql_diagnostics.fingerprint("SELECT count(*) FROM sqlite_master"),
    }
    for entry in event["slow_sql"]:
        assert entry["operation"] == "SELECT"
        assert len(entry["fingerprint"]) == sql_diagnostics.FINGERPRINT_LENGTH


def test_fingerprint_ignores_values_params_and_formatting() -> None:
    """Один шаблон — один отпечаток, чем бы ни были заполнены значения."""
    from_code = sql_diagnostics.fingerprint(
        "SELECT id FROM residents WHERE id = :resident_id AND name = 'Иванов'"
    )
    from_psycopg = sql_diagnostics.fingerprint(
        "SELECT id FROM residents WHERE id = %(resident_id)s AND name = %(name)s"
    )
    from_sqlite = sql_diagnostics.fingerprint("SELECT id FROM residents WHERE id = ? AND name = ?")
    with_other_values = sql_diagnostics.fingerprint(
        "SELECT  id  FROM residents\n WHERE id = 42 AND name = 'Петров'"
    )
    assert from_code == from_psycopg == from_sqlite == with_other_values
    # Другой шаблон — другой отпечаток.
    assert sql_diagnostics.fingerprint("SELECT id FROM residents ORDER BY name") != from_code


def test_context_is_reset_and_does_not_leak_into_the_next_request(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Соседний запрос начинает счёт с нуля, а после ответа контекста нет."""
    always_slow(monkeypatch)

    with stand(engine) as client:
        assert client.get("/api/items/1").status_code == 200
        assert client.get("/api/empty").status_code == 200

    assert sql_diagnostics.current() is None
    first, second = events(capsys)
    assert first["sql_count"] == 3
    assert second["sql_count"] == 0
    assert second["sql_ms"] == 0
    assert first["request_id"] != second["request_id"]


def test_parallel_requests_do_not_share_counters() -> None:
    """Контекст запроса не общий: параллельные запросы считают каждый своё.

    Потоки берут собственные движки: важен не доступ к базе, а то, что
    `ContextVar` не путает выполнения разных запросов.
    """

    def measure(statements: int) -> tuple[int, int, float]:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        token = sql_diagnostics.start_request(f"request-{statements}")
        try:
            with engine.connect() as connection:
                for _ in range(statements):
                    connection.execute(text("SELECT 1"))
            request = sql_diagnostics.current()
            assert request is not None
            return request.count, len(request.templates), request.total_ms
        finally:
            sql_diagnostics.finish_request(token)
            engine.dispose()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(pool.map(measure, [3, 11]))

    assert first[0] == 3
    assert second[0] == 11
    assert first[1] == 1
    assert second[1] == 1
    assert first[2] > 0
    assert second[2] > 0


def test_failed_handler_is_reported_and_context_is_dropped(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Падение ручки видно в записи как 500, контекст после него снят."""
    always_slow(monkeypatch)

    with stand(engine) as client:
        assert client.get("/api/boom").status_code == 500

    assert sql_diagnostics.current() is None
    [event] = events(capsys)
    assert event["route"] == "/api/boom"
    assert event["status"] == 500
    assert event["failed"] is True


def test_metrics_scrape_is_not_measured(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """Скрейп `/metrics` не попадает ни в метрики SQL, ни в события."""
    always_slow(monkeypatch)

    with stand(engine) as client:
        for _ in range(3):
            assert client.get("/metrics").status_code == 200
        text_body = exposure(client)

    assert value(text_body, "http_sql_statements_total", route="/metrics") == 0
    assert all(
        labels.get("route") != "/metrics"
        for name in ("http_sql_statements_total", "http_request_sql_duration_seconds_count")
        for labels, _ in samples(text_body, name)
    )


def measured_routes(client: TestClient) -> set[str]:
    """Маршруты, по которым в процессе уже есть серии метрик SQL."""
    return {
        labels.get("route", "")
        for labels, _ in samples(exposure(client), "http_sql_statements_total")
    }


def test_non_api_paths_are_not_measured(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """Служебные запросы вне клиентского API новых серий не заводят.

    Реестр метрик общий на процесс, и серии других тестов в нём уже лежат,
    поэтому проверяется не «какие маршруты есть», а «стало ли их больше».
    """
    always_slow(monkeypatch)

    with stand(engine) as client:
        before = measured_routes(client)
        openapi = client.get("/openapi.json")
        assert openapi.status_code == 200
        assert client.get("/metrics").status_code == 200
        after = measured_routes(client)

    assert after == before
    assert "/openapi.json" not in after
    assert "/metrics" not in after


def test_prometheus_labels_never_carry_request_id_or_fingerprint(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Кардинальность метки задаёт код: ни `request_id`, ни fingerprint в метках."""
    always_slow(monkeypatch)

    with stand(engine) as client:
        assert client.get("/api/items/1").status_code == 200
        text_body = exposure(client)

    for name in (
        "http_sql_statements_total",
        "http_request_sql_duration_seconds_count",
        "http_request_sql_duration_seconds_sum",
    ):
        for labels, _ in samples(text_body, name):
            assert set(labels) == {"method", "route"}
            assert all("/api/items/1" not in item for item in labels.values())


def test_slow_sql_threshold_filters_templates(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Порог шаблона решает, попадёт ли он в событие: ниже — не попадает."""
    monkeypatch.setattr(sql_diagnostics, "slow_request_threshold_ms", lambda: 0)
    monkeypatch.setattr(sql_diagnostics, "slow_sql_threshold_ms", lambda: 0)
    with stand(engine) as client:
        assert client.get("/api/items/1").status_code == 200
    [with_templates] = events(capsys)
    assert len(with_templates["slow_sql"]) == 3
    assert with_templates["slow_sql"][0]["total_ms"] >= with_templates["slow_sql"][-1]["total_ms"]

    monkeypatch.setattr(sql_diagnostics, "slow_sql_threshold_ms", lambda: 10**6)
    with stand(engine) as client:
        assert client.get("/api/items/1").status_code == 200
    [without_templates] = events(capsys)
    assert without_templates["slow_sql"] == []
    # Отсечение шаблонов не мешает считать сам запрос: числа те же.
    assert without_templates["sql_count"] == with_templates["sql_count"]


def test_real_routes_share_one_mechanism(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Разные боевые маршруты, включая `/api/personnel`, считаются одинаково."""
    monkeypatch.setattr(sql_diagnostics, "slow_request_threshold_ms", lambda: 60_000)
    sign_in(client, db_session)

    assert client.get("/api/dormitories").status_code == 200
    assert client.get("/api/personnel").status_code == 200

    text_body = exposure(client)
    for route in ("/api/dormitories", "/api/personnel"):
        assert value(text_body, "http_sql_statements_total", route=route) > 0
        assert value(text_body, "http_request_sql_duration_seconds_count", route=route) > 0
        assert value(text_body, "http_request_sql_duration_seconds_sum", route=route) > 0


def test_fingerprints_command_finds_template_in_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Команда находит в коде шаблон по отпечатку из события."""
    source = tmp_path / "module.py"
    source.write_text(
        'SQL = "SELECT id FROM residents WHERE dormitory_id = :dormitory_id"\n',
        encoding="utf-8",
    )
    # Так тот же шаблон выглядит у слушателя: psycopg подставляет `%(name)s`,
    # SQLite — `?`. Отпечаток обязан совпасть со всеми тремя видами.
    expected = sql_diagnostics.fingerprint(
        "SELECT id FROM residents WHERE dormitory_id = %(dormitory_id)s"
    )
    assert expected == sql_diagnostics.fingerprint(
        "SELECT id FROM residents WHERE dormitory_id = ?"
    )

    assert sql_fingerprints.main(["--scan", str(tmp_path)]) == sql_fingerprints.EXIT_OK
    assert "module.py:1" in capsys.readouterr().out

    assert (
        sql_fingerprints.main(["--scan", str(tmp_path), "--fingerprint", expected])
        == sql_fingerprints.EXIT_OK
    )
    found = capsys.readouterr().out
    assert "module.py:1" in found
    assert "SELECT id FROM residents WHERE dormitory_id = ?" in found


def test_fingerprints_command_reports_missing_fingerprint(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Неизвестный отпечаток — код 2, а не «ничего не найдено»: его видит оператор."""
    source = tmp_path / "module.py"
    source.write_text(
        'SQL = "SELECT id FROM residents WHERE dormitory_id = :dormitory_id"\n',
        encoding="utf-8",
    )

    assert (
        sql_fingerprints.main(["--scan", str(tmp_path), "--fingerprint", "0" * 12])
        == sql_fingerprints.EXIT_NOT_FOUND
    )
    assert "не найден" in capsys.readouterr().err


def test_fingerprints_command_prints_fingerprint_of_given_sql(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`--sql` печатает отпечаток и нормализованную форму: значения вырезаны."""
    assert (
        sql_fingerprints.main(["SELECT id FROM residents WHERE name = 'Иванов' AND id = 42"])
        == sql_fingerprints.EXIT_OK
    )
    printed = capsys.readouterr().out.splitlines()
    assert printed[0] == sql_diagnostics.fingerprint(
        "SELECT id FROM residents WHERE name = ? AND id = ?"
    )
    assert printed[1] == "SELECT id FROM residents WHERE name = ? AND id = ?"


def test_generate_latest_keeps_previous_metric_contract() -> None:
    """Прежние имена метрик #213 на месте: новая задача их не переименовала."""
    text_body = generate_latest().decode()
    for name in ("http_requests_total", "http_request_duration_seconds", "db_size_bytes"):
        assert name in text_body


# --- Разметка этапов обработчика (#237) -------------------------------------
#
# SQL-слой отвечает «сколько времени в базе», но не отвечает «куда ушло
# остальное». Этапы размечает сам обработчик, а их время копится в том же
# `RequestSql` и уходит в событие полем `stages_ms`.


def test_stage_is_a_noop_outside_a_request() -> None:
    """Разметка стоит в доменном коде: вне запроса она молча ничего не делает."""
    assert sql_diagnostics.current() is None
    with sql_diagnostics.stage("sources"):
        pass
    assert sql_diagnostics.current() is None


def test_stage_records_the_time_even_when_the_step_fails() -> None:
    """`finally` внутри разметки: исключение не съедает уже измеренное время."""
    token = sql_diagnostics.start_request("probe")
    try:
        with pytest.raises(RuntimeError), sql_diagnostics.stage("sources"):
            raise RuntimeError("этап падает")
        request = sql_diagnostics.current()
        assert request is not None
        assert set(request.stages_ms) == {"sources"}
    finally:
        sql_diagnostics.finish_request(token)


def test_stage_time_of_the_request_lands_in_the_event(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Время размеченных этапов попадает в событие, повторный заход суммируется."""
    always_slow(monkeypatch)

    with stand(engine) as client:
        assert client.get("/api/staged").status_code == 200

    [event] = events(capsys)
    stages = event["stages_ms"]
    assert set(stages) == {"sources", "assemble"}
    # `sources` — один заход на 30 мс, `assemble` — два по 4 мс: копится сумма.
    assert stages["sources"] >= 30
    assert stages["assemble"] >= 8
    # В событие время уходит с одним знаком после запятой.
    for value in stages.values():
        assert value == round(value, 1)


def test_stages_breakdown_keeps_the_eight_slowest_in_descending_order() -> None:
    """В событие идут самые долгие этапы: потолок — восемь, порядок — по времени."""
    request = sql_diagnostics.RequestSql(request_id="probe", started=0.0)
    assert sql_diagnostics.stages_breakdown(request) == {}

    for index in range(10):
        request.add_stage(f"stage{index}", float(index))
    breakdown = sql_diagnostics.stages_breakdown(request)

    assert list(breakdown) == [f"stage{index}" for index in range(9, 1, -1)]
    timed = list(breakdown.values())
    assert timed == sorted(timed, reverse=True)
