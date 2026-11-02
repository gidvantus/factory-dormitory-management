"""Организации платформы: список и карточка для кабинета оператора.

Это отдельный, платформенный контур: его открывает не cookie основного кабинета,
а сервисный токен кабинета оператора (`X-Operator-Token`). Поэтому и схемы
отдельные, а не `OrganizationResponse`: в кабинете пользователя `organization_id`
нет ни в одном запросе или ответе, а здесь он — предмет запроса, и рядом с ним
нужны счётчики, которых в кабинете клиента не бывает.

Тело правки своей схемы не имеет намеренно: это существующая
`UpdateOrganizationRequest` из `app/schemas/organization.py`. Тексты отказов и
правило ИНН обязаны остаться одни на весь API — копия неминуемо разошлась бы с
оригиналом.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class PlatformOrganizationListItem(BaseModel):
    """Строка списка организаций платформы.

    `name` и `inn` приходят `null` у пустой заготовки: организация заводится
    активацией кабинета раньше, чем пользователь заполнит реквизиты.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str | None
    inn: str | None
    created_at: datetime


class PlatformOrganizationDetails(PlatformOrganizationListItem):
    """Карточка организации: те же поля плюс реквизиты и счётчики.

    `members_count` считает строки `organization_members` вместе с владельцем:
    в кабинете оператора это «сколько людей в организации», а не «сколько
    сотрудников сверх владельца». `dormitories_count` считает и архивные
    общежития: архив — статус, а не удаление.
    """

    kpp: str | None
    ogrn: str | None
    address: str | None
    members_count: int = Field(examples=[3])
    dormitories_count: int = Field(examples=[2])


class PlatformOrganizationPage(BaseModel):
    """Страница списка: элементы и общее число организаций по тем же условиям.

    `total` считается отдельным запросом и не зависит от `limit`/`offset`:
    по нему фронт понимает, есть ли ещё страница, — пока
    `len(items) < total`, «Показать ещё» видна.
    """

    items: list[PlatformOrganizationListItem]
    total: int = Field(examples=[60])
