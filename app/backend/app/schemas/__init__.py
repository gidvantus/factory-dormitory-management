"""Схемы API."""

from app.schemas.activation import (
    ActivateRequest,
    ActivationInfoResponse,
    ResendActivationRequest,
    ResendActivationResponse,
)
from app.schemas.user import (
    LoginRequest,
    RegisterRequest,
    RegisterResponse,
    UserResponse,
    normalize_email,
)

__all__ = [
    "ActivateRequest",
    "ActivationInfoResponse",
    "LoginRequest",
    "RegisterRequest",
    "RegisterResponse",
    "ResendActivationRequest",
    "ResendActivationResponse",
    "UserResponse",
    "normalize_email",
]
