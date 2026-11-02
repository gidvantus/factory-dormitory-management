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


class ForwardedBody(BaseModel):
    """Тело правки, которое кабинет передаёт основному API как есть.

    Лишние поля разрешены и тоже уходят наверх: их разбирает основной API и
    отвечает на них своим `422`, а не кабинет — своих правил проверки значений
    здесь нет намеренно. Второй экземпляр правил и текстов отказов разошёлся бы
    с оригиналом на первой же правке.
    """

    model_config = ConfigDict(extra="allow")

    def forwarded(self) -> dict[str, Any]:
        """Только присланные поля: `{"address": ...}` остаётся одним полем.

        Лишние поля (`extra="allow"`) добавляются явно: их разбирает основной API
        и отвечает на них своим `422`, а не кабинет.
        """
        data = self.model_dump(exclude_unset=True)
        data.update(self.__pydantic_extra__ or {})
        return data


class UpdateOrganizationRequest(ForwardedBody):
    """Тело правки организации — то, что кабинет передаёт основному API.

    Поля необязательны, и уходят только те, что были в теле: отсутствующее поле
    не обнуляется.
    """

    name: str | None = None
    inn: str | None = None
    kpp: str | None = None
    ogrn: str | None = None
    address: str | None = None


# --- Пользователи платформы --------------------------------------------------
# Те же правила, что у организаций: модели повторяют форму ответа основного API
# один в один, а тела правки проверяются там же, наверху.


class PlatformUser(BaseModel):
    """Строка реестра учётных записей платформы.

    `organization_id`, `organization_name` и `role` бывают `null` вместе: у
    пользователя без организации нет ни её названия, ни строки членства, а
    значит и роли. `is_active` — «кабинет активирован», а не «заблокирован».
    """

    id: int
    email: str
    full_name: str
    is_active: bool
    organization_id: int | None
    organization_name: str | None
    role: str | None
    created_at: datetime


class PlatformUserPage(BaseModel):
    """Страница списка: элементы и общее число пользователей.

    Пока `len(items) < total`, у списка есть что догружать.
    """

    items: list[PlatformUser]
    total: int


class UpdatePlatformUserRequest(ForwardedBody):
    """Тело правки пользователя: единственное поле — ФИО.

    Проверок здесь нет: пустое ФИО отсекает основной API своим `422` с текстом
    «ФИО не может быть пустым», и кабинет передаёт его дословно.
    """

    full_name: str | None = None
