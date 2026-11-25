"""Подключение к базе данных и выдача сессий SQLAlchemy."""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

# Таймаут установления соединения, в секундах. `statement_timeout` (журнал
# действий, размер базы для метрик) ограничивает сам запрос, но не ожидание
# соединения: если хост базы перестанет отвечать без отказа (контейнер в паузе,
# пропала сеть), подключение висело бы до TCP-таймаута. Для API это лишнее
# ожидание в каждом запросе, а для скрейпа `/metrics` — повод не уложиться в
# `scrape_timeout` и получить ложный `TargetDown` (#213).
DB_CONNECT_TIMEOUT_SECONDS = 5

# Параметр передаётся psycopg как `connect_timeout`; у SQLite (юнит-прогон) его
# нет, поэтому набор аргументов зависит от схемы подключения.
_connects_to_postgres = get_settings().database_url.startswith("postgresql")
CONNECT_ARGS: dict[str, int] = (
    {"connect_timeout": DB_CONNECT_TIMEOUT_SECONDS} if _connects_to_postgres else {}
)

engine = create_engine(get_settings().database_url, pool_pre_ping=True, connect_args=CONNECT_ARGS)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """Сессия на один запрос: закрывается всегда, даже при исключении."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
