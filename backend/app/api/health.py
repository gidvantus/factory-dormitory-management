"""Проверка живости сервиса."""

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health", summary="Сервис отвечает")
def health() -> dict[str, str]:
    return {"status": "ok"}
