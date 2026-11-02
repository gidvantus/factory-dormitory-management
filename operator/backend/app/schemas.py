"""Схемы запросов и ответов кабинета оператора.

Это и есть контракт с фронтендом: сюда попадает только то, что видно снаружи.
Успех входа, «кто вошёл» и отказ описываются этими моделями, поэтому схема
OpenAPI (`/openapi.json` и `/docs`) собирается из них, а не из документации
рядом.
"""

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    """Тело входа. Оба поля обязательны, но пустая строка — не `422`, а `401`."""

    username: str
    password: str


class OperatorResponse(BaseModel):
    """Кто вошёл: логин единственного оператора из конфига."""

    username: str = Field(examples=["operator"])


class ErrorResponse(BaseModel):
    """Отказ. `detail` фронтенд показывает дословно, без переписывания."""

    detail: str = Field(examples=["Неверный логин или пароль"])


class HealthResponse(BaseModel):
    """Ответ проверки живости: по нему стенд ждёт готовности сервиса."""

    status: str = Field(examples=["ok"])
