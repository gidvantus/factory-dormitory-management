"""Общие фикстуры тестов кабинета оператора.

Тесты герметичны: ни базы, ни сети — сервису некуда ходить, у него нет ни
хранилища, ни обмена с основным кабинетом.
"""

import os

# Настройки читаются из окружения до импорта приложения, поэтому переменные
# выставляем здесь — до первых импортов app.*. Жёстко, а не setdefault: на стенде
# те же имена приходят из compose, а тесты проверяют контракт, а не настройки
# конкретного стенда (иначе `Max-Age` в cookie зависел бы от `.env`).
os.environ["OPERATOR_USERNAME"] = "operator"
os.environ["OPERATOR_PASSWORD"] = "unit-test-operator-password"
os.environ["OPERATOR_TOKEN_SECRET"] = "unit-test-operator-secret-0123456789"
os.environ["OPERATOR_TOKEN_TTL_HOURS"] = "12"
os.environ["OPERATOR_SESSION_COOKIE_SECURE"] = "false"

from collections.abc import Callable, Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.main_api import main_api_client

# Логин, пароль и срок жизни сессии, которые видят тесты: те же, что выставлены
# выше. Импортируются тестами как константы, чтобы ожидания не дублировались.
TEST_OPERATOR_USERNAME = "operator"
TEST_OPERATOR_PASSWORD = "unit-test-operator-password"
TEST_OPERATOR_TOKEN_SECRET = "unit-test-operator-secret-0123456789"


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Клиент приложения. Контекстный менеджер поднимает и гасит приложение."""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def settings_cache() -> Iterator[None]:
    """Сбросить кэш настроек до и после теста.

    Нужен тестам, которые меняют окружение: `get_settings` под `lru_cache`, и без
    сброса тест увидел бы значения, прочитанные прошлым тестом.
    """
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# --- Подставной основной API -------------------------------------------------
# Общие помощники обоих проксирующих разделов (`test_organizations.py`,
# `test_users.py`): кабинет ходит наверх по HTTP, и единственное, что стоит
# проверять в нём, — что именно он отправляет и как возвращает ответ.

SERVICE_TOKEN = "unit-test-operator-service-token"
BASE_URL = "http://api.test"


class MainApi:
    """Подставной основной API: запоминает запросы и отвечает заданным."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.handler: Callable[[httpx.Request], httpx.Response] = lambda request: httpx.Response(
            200, json={}
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)


def _transport_client(api: MainApi) -> Callable[[], Iterator[httpx.Client]]:
    """Клиент кабинета на `httpx.MockTransport`: настоящей сети нет."""

    def _client() -> Iterator[httpx.Client]:
        with httpx.Client(
            transport=httpx.MockTransport(api.handle),
            base_url=BASE_URL,
        ) as client:
            yield client

    return _client


@pytest.fixture
def main_api(monkeypatch: pytest.MonkeyPatch, settings_cache: None) -> Iterator[MainApi]:
    """Основной API подменён транспортом, а секрет контура выставлен явно."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", SERVICE_TOKEN)
    get_settings.cache_clear()
    api = MainApi()
    app.dependency_overrides[main_api_client] = _transport_client(api)
    try:
        yield api
    finally:
        app.dependency_overrides.pop(main_api_client, None)
        get_settings.cache_clear()


@pytest.fixture
def empty_token(monkeypatch: pytest.MonkeyPatch, settings_cache: None) -> Iterator[MainApi]:
    """Пустой секрет контура: кабинет отвечает 503 и в сеть не идёт."""
    monkeypatch.setenv("OPERATOR_SERVICE_TOKEN", "")
    get_settings.cache_clear()
    api = MainApi()
    app.dependency_overrides[main_api_client] = _transport_client(api)
    try:
        yield api
    finally:
        app.dependency_overrides.pop(main_api_client, None)
        get_settings.cache_clear()


def login(client: TestClient) -> None:
    """Войти оператором: ручки кабинета закрыты сессией."""
    response = client.post(
        "/api/auth/login",
        json={"username": TEST_OPERATOR_USERNAME, "password": TEST_OPERATOR_PASSWORD},
    )
    assert response.status_code == 200, response.text


def respond(detail: object, status_code: int) -> Callable[[httpx.Request], httpx.Response]:
    """Обработчик, отвечающий заданным отказом основного API."""
    return lambda request: httpx.Response(status_code, json={"detail": detail})
