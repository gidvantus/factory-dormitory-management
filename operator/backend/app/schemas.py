"""Схемы запросов и ответов кабинета оператора.

Это и есть контракт с фронтендом: сюда попадает только то, что видно снаружи.
Успех входа, «кто вошёл» и отказ описываются этими моделями, поэтому схема
OpenAPI (`/openapi.json` и `/docs`) собирается из них, а не из документации
рядом.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


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


# --- Организации платформы ---------------------------------------------------
# Эти модели — форма ответа основного API, повторённая один в один: кабинет
# ничего не добавляет и не переименовывает, иначе фронтенд знал бы два разных
# контракта на одни и те же данные. Тексты отказов сюда не входят: они приходят
# из основного API и показываются дословно.


class OrganizationListItem(BaseModel):
    """Строка списка организаций. Название и ИНН бывают `null` у пустой заготовки."""

    id: int
    name: str | None
    inn: str | None
    created_at: datetime


class OrganizationDetails(BaseModel):
    """Карточка организации: реквизиты и счётчики участников и общежитий."""

    id: int
    name: str | None
    inn: str | None
    kpp: str | None
    ogrn: str | None
    address: str | None
    created_at: datetime
    members_count: int
    dormitories_count: int


class OrganizationPage(BaseModel):
    """Страница списка: элементы и общее число организаций.

    Пока `len(items) < total`, у списка есть что догружать.
    """

    items: list[OrganizationListItem]
    total: int


class UpdateOrganizationRequest(BaseModel):
    """Тело правки организации — то, что кабинет передаёт основному API.

    Поля необязательны, и уходят только те, что были в теле: отсутствующее поле
    не обнуляется. Проверок значений здесь нет намеренно — правило ИНН и текст
    отказа «Название не может быть пустым» живут в основном API, и второй их
    экземпляр в кабинете разошёлся бы с оригиналом. Лишние поля разрешены и
    тоже уходят наверх: отказ по ним приходит из основного API.
    """

    model_config = ConfigDict(extra="allow")

    name: str | None = None
    inn: str | None = None
    kpp: str | None = None
    ogrn: str | None = None
    address: str | None = None

    def forwarded(self) -> dict[str, Any]:
        """Только присланные поля: `{"address": ...}` остаётся одним полем.

        Лишние поля (`extra="allow"`) добавляются явно: их разбирает основной API
        и отвечает на них своим `422`, а не кабинет — своих правил здесь нет.
        """
        data = self.model_dump(exclude_unset=True)
        data.update(self.__pydantic_extra__ or {})
        return data
