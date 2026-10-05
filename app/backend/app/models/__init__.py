"""Модели таблиц."""

from app.models.base import Base
from app.models.dormitory import Dormitory
from app.models.user import User

__all__ = ["Base", "Dormitory", "User"]
