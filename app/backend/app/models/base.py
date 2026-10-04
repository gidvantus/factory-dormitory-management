"""Базовый класс моделей."""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Общий предок всех таблиц: по нему alembic собирает метаданные."""
