"""Схемы API."""

from app.schemas.user import (
    LoginRequest,
    RegisterRequest,
    RegisterResponse,
    UserResponse,
    normalize_email,
)

__all__ = [
    "LoginRequest",
    "RegisterRequest",
    "RegisterResponse",
    "UserResponse",
    "normalize_email",
]
