"""Метрики Prometheus (issue #213): контракт `/metrics` и метки middleware.

Тесты держат шов «приложение ↔ Prometheus»: имена метрик, набор меток и
значения метки `route` заморожены — по ним строятся панели дашбордов и правила
алертов, поэтому расхождение должно падать здесь, а не на сервере.

Счётчики и гистограмма живут в процессе целиком, а не в фикстуре, поэтому
проверки считают **прирост** от снятого снимка, а не абсолютное значение.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from prometheus_client import generate_latest
from starlette.responses import Response

from app import metrics


def samples(text: str, name: str) -> list[tuple[dict[str, str], float]]:
    """Серии одной метрики из текста экспозиции — вместе с их метками."""
    result: list[tuple[dict[str, str], float]] = []
    for line in text.splitlines():
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


def exposure(client: TestClient) -> str:
    """Текст `/metrics`. Скрейп в метриках не считается — снимок безопасен."""
    response = client.get("/metrics")
    assert response.status_code == 200
    return response.text


def value(text: str, name: str, **labels: str) -> float:
    """Значение серии по имени метрики и меткам; отсутствие серии — 0."""
    for sample_labels, sample_value in samples(text, name):
        if all(sample_labels.get(key) == expected for key, expected in labels.items()):
            return sample_value
    return 0.0


def totals(client: TestClient) -> dict[tuple[tuple[str, str], ...], float]:
    """Все серии `http_requests_total` снимком: так проверяется «не считается»."""
    return {
        tuple(sorted(labels.items())): sample_value
        for labels, sample_value in samples(exposure(client), "http_requests_total")
    }


def test_counter_grows_per_method_and_status(client: TestClient) -> None:
    """Счётчик растёт по методу и статусу: успех и отказ считаются отдельно."""
    before = value(
        exposure(client), "http_requests_total", method="GET", status="200", route="/api/health"
    )

    assert client.get("/api/health").status_code == 200

    text = exposure(client)
    assert value(text, "http_requests_total", method="GET", status="200", route="/api/health") == (
        before + 1
    )

    # Другой метод и другой статус — отдельная серия, а не та же.
    failed_before = value(
        text, "http_requests_total", method="POST", status="422", route="/api/auth/register"
    )
    assert client.post("/api/auth/register", json={}).status_code == 422
    assert value(
        exposure(client),
        "http_requests_total",
        method="POST",
        status="422",
        route="/api/auth/register",
    ) == (failed_before + 1)


def test_route_label_is_a_template_not_an_identifier(client: TestClient) -> None:
    """Метка `route` — шаблон маршрута, а не путь с идентификатором."""
    client.get("/api/dormitories/42")

    text = exposure(client)
    assert (
        value(
            text,
            "http_requests_total",
            method="GET",
            route="/api/dormitories/{dormitory_id}",
        )
        > 0
    )
    assert (
        value(
            text,
            "http_request_duration_seconds_count",
            method="GET",
            route="/api/dormitories/{dormitory_id}",
        )
        > 0
    )
    # Кардинальность: конкретный идентификатор не должен попасть ни в одну серию.
    routes = {
        labels.get("route", "")
        for name in ("http_requests_total", "http_request_duration_seconds_count")
        for labels, _ in samples(text, name)
    }
    assert all("/api/dormitories/42" not in route for route in routes)


def test_unknown_path_is_unmatched(client: TestClient) -> None:
    """Несопоставленный путь даёт `unmatched`: путь клиента в метку не попадает."""
    client.get("/api/no-such-route")

    text = exposure(client)
    assert value(text, "http_requests_total", method="GET", status="404", route="unmatched") > 0
    assert all(
        "no-such-route" not in labels.get("route", "")
        for labels, _ in samples(text, "http_requests_total")
    )


def crash_client() -> TestClient:
    """Приложение с падающей ручкой: проверять 500 на боевых путях незачем.

    `/metrics` объявлен здесь же: снимок метрик нужен, чтобы увидеть прирост, но
    клиентский контракт боевого приложения для этого теста не требуется.
    """
    application = FastAPI()
    application.middleware("http")(metrics.middleware)

    @application.get("/metrics", include_in_schema=False)
    def metrics_endpoint() -> Response:
        return metrics.exposition()

    @application.get("/boom")
    def boom() -> dict[str, str]:
        raise RuntimeError("ручка падает")

    return TestClient(application, raise_server_exceptions=False)


def test_handler_crash_is_counted_as_500() -> None:
    """Исключение из ручки считается как `status="500"` и не глотается."""
    with crash_client() as client:
        before = value(
            exposure(client), "http_requests_total", method="GET", status="500", route="/boom"
        )

        assert client.get("/boom").status_code == 500

        text = exposure(client)
    assert value(text, "http_requests_total", method="GET", status="500", route="/boom") == (
        before + 1
    )
    assert value(text, "http_request_duration_seconds_count", method="GET", route="/boom") == 1


def test_metrics_scrape_is_not_counted(client: TestClient) -> None:
    """Скрейп `/metrics` не считается: иначе он искажает RPS и латентность."""
    before = totals(client)

    for _ in range(3):
        assert client.get("/metrics").status_code == 200

    assert totals(client) == before


def test_metrics_endpoint_contract(client: TestClient) -> None:
    """`/metrics`: 200, формат Prometheus, три метрики шва и нет в `/openapi.json`."""
    response = client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain; version=0.0.4")
    body = response.text
    assert "http_requests_total" in body
    assert "http_request_duration_seconds_bucket" in body
    assert "db_size_bytes" in body
    assert "/metrics" not in client.get("/openapi.json").json()["paths"]


def test_broken_db_does_not_break_metrics(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Недоступная база не роняет `/metrics`: отдаётся прошлое значение."""

    def unavailable() -> int:
        raise RuntimeError("база недоступна")

    monkeypatch.setattr(metrics, "query_db_size_bytes", unavailable)
    monkeypatch.setattr(metrics, "_last_db_size_check", None)

    response = client.get("/metrics")

    assert response.status_code == 200
    assert "db_size_bytes" in response.text


def test_db_size_is_refreshed_not_more_often_than_every_30_seconds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Размер базы читается лениво: не чаще раза в 30 с, значение уходит в gauge."""
    calls: list[int] = []

    def size() -> int:
        calls.append(1)
        return 2_000_000

    monkeypatch.setattr(metrics, "query_db_size_bytes", size)
    monkeypatch.setattr(metrics, "_last_db_size_check", None)

    metrics.refresh_db_size(now=100.0)
    metrics.refresh_db_size(now=110.0)
    assert len(calls) == 1

    metrics.refresh_db_size(now=131.0)
    assert len(calls) == 2

    exposition = generate_latest().decode()
    assert value(exposition, "db_size_bytes") == 2_000_000
