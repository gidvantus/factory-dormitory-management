"""Общие фикстуры тестов.

Юнит-тесты герметичны: поднимается SQLite в памяти, настоящая PostgreSQL не нужна.
Почта наружу тоже не ходит — SMTP отключён до импорта приложения, поэтому
фоновые задачи регистрации выходят раньше первого сетевого вызова.
"""

import os

# Настройки читаются из окружения до импорта приложения, поэтому переменные
# выставляем здесь — до первых импортов app.*.
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("JWT_SECRET", "unit-test-secret-value-0123456789")
# Жёстко, а не setdefault: на стенде SMTP_HOST приходит из compose, и тесты
# не должны из-за этого стучаться в настоящий smtp.timeweb.ru.
os.environ["SMTP_HOST"] = ""
os.environ["SMTP_PASSWORD"] = ""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import get_db
from app.main import app
from app.models import Base
from app.models.organization import Organization, OrganizationMember
from app.models.user import User
from app.security import hash_password

# Пароль, которым тесты входят в кабинет. Сервер его не показывает, поэтому
# пользователь с известным паролем создаётся прямо в базе (см. create_user).
TEST_PASSWORD = "unit-test-password"


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
) -> dict[str, object]:
    """Регистрирует пользователя через API.

    Открытый пароль сервер не возвращает: вход в тестах идёт через `create_user`.
    """
    response = client.post(
        "/api/auth/register",
        json={"email": email, "full_name": full_name},
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_user(
    db_session: Session,
    email: str = "worker@example.com",
    full_name: str = "Иванов Иван Иванович",
    password: str = TEST_PASSWORD,
    is_active: bool = True,
) -> User:
    """Пользователь с известным паролем: тест может войти, не зная служебный."""
    user = User(
        email=email.strip().lower(),
        full_name=full_name,
        password_hash=hash_password(password),
        is_active=is_active,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def login(client: TestClient, email: str, password: str = TEST_PASSWORD) -> Response:
    """Вход по паролю известного тестового пользователя."""
    return client.post("/api/auth/login", json={"email": email, "password": password})


def sign_in(
    client: TestClient,
    db_session: Session,
    email: str = "worker@example.com",
    is_active: bool = True,
) -> User:
    """Создать пользователя и войти им. Возвращает строку пользователя в базе."""
    user = create_user(db_session, email=email, is_active=is_active)
    response = login(client, email)
    assert response.status_code == 200, response.text
    return user


def organizations_for(
    db_session: Session,
    user: User,
    role: str = "owner",
    name: str | None = None,
    inn: str | None = None,
) -> tuple[Organization, OrganizationMember]:
    """Завести пользователю организацию напрямую в базе.

    `create_user` создаёт пользователя минуя активацию, поэтому организации ему
    никто не заводит. Роль нужна отличной от `owner`, чтобы проверить 403 на
    правке, а имя и ИНН — чтобы подготовить конфликт по уникальному ИНН.
    """
    organization = Organization(name=name, inn=inn)
    db_session.add(organization)
    db_session.flush()
    membership = OrganizationMember(
        organization_id=organization.id,
        user_id=user.id,
        role=role,
    )
    db_session.add(membership)
    user.active_organization_id = organization.id
    db_session.commit()
    db_session.refresh(organization)
    db_session.refresh(membership)
    return organization, membership
