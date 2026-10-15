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
# По той же причине пуст ключ DaData: на стенде он приходит из compose, а тесты
# не должны ходить в настоящий suggestions.dadata.ru. Подменённый HTTP-клиент
# для разбора ответа живёт в tests/test_dadata.py.
os.environ["DADATA_API_KEY"] = ""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import db as db_module
from app import solutions
from app.config import get_settings
from app.db import get_db
from app.main import app
from app.models import Base
from app.models.organization import Organization, OrganizationMember
from app.models.solution import OrganizationSolution, Solution
from app.models.user import User
from app.security import hash_password

# Пароль, которым тесты входят в кабинет. Сервер его не показывает, поэтому
# пользователь с известным паролем создаётся прямо в базе (см. create_user).
TEST_PASSWORD = "unit-test-password"


@pytest.fixture
def db_engine(monkeypatch: pytest.MonkeyPatch) -> Iterator[Engine]:
    """Свежая схема на каждый тест: тесты не делят состояние.

    Служебные сессии журнала действий (`app.audit` берёт фабрику из модуля
    `app.db`) переводятся на эту же базу. Иначе строки журнала уходили бы в
    настоящее подключение из окружения стенда, и юнит-прогон перестал бы быть
    герметичным.
    """
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    monkeypatch.setattr(
        db_module,
        "SessionLocal",
        sessionmaker(bind=engine, autoflush=False, expire_on_commit=False),
    )
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
    Согласие на обработку данных обязательно, поэтому здесь оно всегда отмечено:
    сценарии без согласия проверяет `tests/test_register.py`.
    """
    response = client.post(
        "/api/auth/register",
        json={"email": email, "full_name": full_name, "consent": True},
    )
    assert response.status_code == 201, response.text
    return response.json()


def active_trial_ends_at() -> datetime:
    """Конец пробного периода, который ещё идёт: так выглядит рабочий кабинет."""
    return datetime.now(UTC) + timedelta(days=get_settings().trial_days)


def create_user(
    db_session: Session,
    email: str = "worker@example.com",
    full_name: str = "Иванов Иван Иванович",
    password: str = TEST_PASSWORD,
    is_active: bool = True,
    trial_ends_at: datetime | None = None,
    trial_active: bool = True,
) -> User:
    """Пользователь с известным паролем: тест может войти, не зная служебный.

    `trial_active=True` (по умолчанию) ставит пользователю идущий пробный
    период: иначе каждая существующая ручка отвечала бы 403 закрытого кабинета
    и все прежние тесты упирались бы в новую проверку. Закрытый кабинет
    собирается явно: `trial_active=False` оставляет дату как передали — `None`
    («пробного периода нет») или прошлое («период истёк»).
    """
    user = User(
        email=email.strip().lower(),
        full_name=full_name,
        password_hash=hash_password(password),
        is_active=is_active,
        trial_ends_at=active_trial_ends_at() if trial_active else trial_ends_at,
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
    trial_ends_at: datetime | None = None,
    trial_active: bool = True,
) -> User:
    """Создать пользователя и войти им. Возвращает строку пользователя в базе."""
    user = create_user(
        db_session,
        email=email,
        is_active=is_active,
        trial_ends_at=trial_ends_at,
        trial_active=trial_active,
    )
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


# Код решения «уведомления в Telegram»: он же стоит в seed-строке каталога.
TELEGRAM_NOTIFICATIONS_CODE = "telegram_notifications"


def add_solution(
    db_session: Session,
    *,
    code: str = TELEGRAM_NOTIFICATIONS_CODE,
    name: str = "Уведомления в Telegram",
    description: str | None = "Сообщения о событиях, которые вас касаются",
    amount: str = "500.00",
    period: str = "month",
    position: int = 1,
    is_visible: bool = True,
) -> Solution:
    """Завести строку каталога решений прямо в базе.

    Юнит-тесты идут на SQLite и схему собирают из моделей, а seed каталога живёт
    в миграции `0035_solutions`: без этой строки магазин был бы пуст, поэтому
    её заводит сам тест.
    """
    solution = Solution(
        code=code,
        name=name,
        description=description,
        amount=Decimal(amount),
        currency="RUB",
        period=period,
        position=position,
        is_visible=is_visible,
    )
    db_session.add(solution)
    db_session.commit()
    db_session.refresh(solution)
    return solution


def give_solution(
    db_session: Session,
    organization: Organization,
    *,
    code: str = TELEGRAM_NOTIFICATIONS_CODE,
    period: str = "month",
    expires_at: datetime | None = None,
    invoice_id: int | None = None,
) -> Solution:
    """Выдать организации право на решение — как это делает оплата счёта.

    Обычный путь — `solutions.grant`: срок считается от момента выдачи. Явный
    `expires_at` нужен там, где проверяется просроченное право: подменить часы
    тест не может.
    """
    solution = add_solution(db_session, code=code, period=period)
    if expires_at is None:
        solutions.grant(db_session, organization.id, solution, invoice_id=invoice_id)
    else:
        db_session.add(
            OrganizationSolution(
                organization_id=organization.id,
                solution_id=solution.id,
                granted_at=expires_at - timedelta(days=30),
                expires_at=expires_at,
                invoice_id=invoice_id,
            )
        )
    db_session.commit()
    return solution
