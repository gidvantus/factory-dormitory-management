"""Проверка живости сервиса.

Ручка открыта анониму и не трогает конфиг: по ней healthcheck стенда решает,
что сервис поднялся, — поэтому она отвечает даже раньше, чем кто-либо вошёл.
"""

from fastapi import APIRouter

from app.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse, summary="Сервис отвечает")
def health() -> HealthResponse:
    """Сервис жив. Тело фиксировано: `{"status": "ok"}`."""
    return HealthResponse(status="ok")
