"""Прокси Telegram в notifier мониторинга: через прокси — только Bot API.

Notifier живёт отдельным стеком (`monitor/`) и своего набора тестов не имеет, а
единственный pytest проекта — этот (`app/backend/tests`), поэтому модуль
загружается по пути. Проверяется ровно шов из #232: при заданном
`MONITOR_TELEGRAM_PROXY_URL` отправка в Bot API идёт через собственный opener с
`ProxyHandler`, а запросы к Prometheus — прежним прямым `urllib.request.urlopen`.

Сети нет: подменены и `build_opener`, и `urlopen`.
"""

import importlib.util
import json
import urllib.request
from pathlib import Path
from types import ModuleType

import pytest


def find_repo_root() -> Path | None:
    """Корень рабочей копии — ближайший предок, где лежит notifier мониторинга.

    Фиксированная глубина тут не годится: в образе `api` файл лежит в
    `/app/tests/`, и `parents[3]` бросает `IndexError` ещё при импорте — до
    `skipif`, который должен был пропустить тест. Индексная адресация ломает
    `docker compose exec api pytest` (сбор тестов падает целиком, включая
    `dbtest`), поэтому корень ищется перебором предков.
    """
    for parent in Path(__file__).resolve().parents:
        if (parent / "monitor" / "notifier" / "app.py").is_file():
            return parent
    return None


REPO_ROOT = find_repo_root()
# В образе `api` каталога `monitor/` нет (образ собирается из `app/backend`),
# поэтому там тест пропускается; в CI и в рабочей копии он идёт.
NOTIFIER_PATH = REPO_ROOT / "monitor" / "notifier" / "app.py" if REPO_ROOT else None

BOT_TOKEN = "111111:notifier-unit-test-token"
CHAT_ID = "123456789"
PROXY_URL = "http://proxy.test:3128"


class FakeResponse:
    """Ответ сети: notifier читает только `read`, ещё нужен контекстный менеджер."""

    def __init__(self, payload: object) -> None:
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False


class RecordingOpener:
    """Подменённый opener: запоминает запросы и отвечает как Telegram."""

    def __init__(self) -> None:
        self.requests: list[urllib.request.Request] = []

    def open(self, request: urllib.request.Request, timeout: float | None = None) -> FakeResponse:
        self.requests.append(request)
        return FakeResponse({"ok": True, "result": {"message_id": 1}})


def load_notifier(monkeypatch: pytest.MonkeyPatch, *, proxy: str) -> ModuleType:
    """Загрузить notifier с заданным окружением: настройки читаются при импорте."""
    path = NOTIFIER_PATH
    assert path is not None, "notifier мониторинга есть только в полной рабочей копии"
    monkeypatch.setenv("MONITOR_TELEGRAM_BOT_TOKEN", BOT_TOKEN)
    monkeypatch.setenv("MONITOR_TELEGRAM_CHAT_ID", CHAT_ID)
    monkeypatch.setenv("MONITOR_TELEGRAM_PROXY_URL", proxy)
    spec = importlib.util.spec_from_file_location("notifier_for_tests", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(NOTIFIER_PATH is None, reason="в образе api нет каталога monitor/")
def test_telegram_goes_through_the_proxy_and_prometheus_stays_direct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notifier = load_notifier(monkeypatch, proxy=PROXY_URL)

    opener = RecordingOpener()
    handlers: list[object] = []

    def build_opener(*given: object) -> RecordingOpener:
        handlers.extend(given)
        return opener

    direct: list[str] = []

    def urlopen(request: urllib.request.Request, timeout: float | None = None) -> FakeResponse:
        direct.append(request.full_url)
        return FakeResponse({"status": "success", "data": {"result": []}})

    monkeypatch.setattr(urllib.request, "build_opener", build_opener)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    assert notifier.send("привет", "АЛЕРТ") is True
    assert notifier.query("up") == []

    # Прокси получил ровно один обработчик — ProxyHandler с адресом из окружения.
    assert len(handlers) == 1
    assert isinstance(handlers[0], urllib.request.ProxyHandler)
    assert handlers[0].proxies == {"http": PROXY_URL, "https": PROXY_URL}

    # В прокси ушёл только Bot API, а не Prometheus.
    assert [request.full_url for request in opener.requests] == [
        f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    ]
    assert len(direct) == 1
    assert direct[0].startswith("http://prometheus:9090/api/v1/query")


@pytest.mark.skipif(NOTIFIER_PATH is None, reason="в образе api нет каталога monitor/")
def test_without_a_proxy_the_notifier_keeps_the_direct_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notifier = load_notifier(monkeypatch, proxy="")
    assert notifier.telegram_opener() is None

    built: list[str] = []

    def build_opener(*given: object) -> RecordingOpener:
        built.append("opener")
        return RecordingOpener()

    direct: list[str] = []

    def urlopen(request: urllib.request.Request, timeout: float | None = None) -> FakeResponse:
        direct.append(request.full_url)
        return FakeResponse({"ok": True, "result": {"message_id": 1}})

    monkeypatch.setattr(urllib.request, "build_opener", build_opener)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    assert notifier.send("привет", "СВОДКА") is True

    # Opener не создаётся вовсе: пустая настройка — прежнее прямое соединение.
    assert built == []
    assert direct == [f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"]
