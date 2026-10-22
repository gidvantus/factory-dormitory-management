"""Схемы API."""

from app.schemas.activation import (
    ActivateRequest,
    ActivationInfoResponse,
    ResendActivationRequest,
    ResendActivationResponse,
)
from app.schemas.user import (
    LoginRequest,
    MeResponse,
    RegisterRequest,
    RegisterResponse,
    UserResponse,
    normalize_email,
)

__all__ = [
    "ActivateRequest",
    "ActivationInfoResponse",
    "LoginRequest",
    "MeResponse",
    "RegisterRequest",
    "RegisterResponse",
    "ResendActivationRequest",
    "ResendActivationResponse",
    "UserResponse",
    "normalize_email",
]
