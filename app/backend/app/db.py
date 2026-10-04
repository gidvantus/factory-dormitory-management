"""Подключение к базе данных и выдача сессий SQLAlchemy."""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

engine = create_engine(get_settings().database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    """Сессия на один запрос: закрывается всегда, даже при исключении."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
