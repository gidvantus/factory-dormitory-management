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

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

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
