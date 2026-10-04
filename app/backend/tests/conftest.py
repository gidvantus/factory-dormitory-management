"""Общие фикстуры тестов.

Юнит-тесты герметичны: поднимается SQLite в памяти, настоящая PostgreSQL не нужна.
"""

import os

# Настройки читаются из окружения до импорта приложения, поэтому переменные
# выставляем здесь — до первых импортов app.*.
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("JWT_SECRET", "unit-test-secret-value-0123456789")

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import get_db
from app.main import app
from app.models import Base


@pytest.fixture
def db_engine() -> Iterator[Engine]:
    """Свежая схема на каждый тест: тесты не делят состояние."""
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture
def db_session(db_engine: Engine) -> Iterator[Session]:
    factory = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db_session: Session) -> Iterator[TestClient]:
    """Клиент API с подменённой базой. Cookie он хранит сам."""

    def override_get_db() -> Iterator[Session]:
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


def register_user(
    client: TestClient,
    email: str = "worker@example.com",
    full_name: str = "Иванов Иван Иванович",
) -> dict[str, str]:
    """Регистрирует пользователя и возвращает тело ответа с открытым паролем."""
    response = client.post(
        "/api/auth/register",
        json={"email": email, "full_name": full_name},
    )
    assert response.status_code == 201, response.text
    return response.json()
