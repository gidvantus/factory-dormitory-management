"""Пользователи платформы: список, карточка и правка ФИО для кабинета оператора.

Контур тот же, что у организаций (`app/schemas/platform_organization.py`):
ручки открывает сервисный токен кабинета оператора (`X-Operator-Token`), а не
cookie основного кабинета. Поэтому схемы отдельные, а не `UserResponse`: в
кабинете клиента ответ — это «то, что человек вводил сам», а здесь строка
реестра учётных записей вместе с организацией и ролью.

В ответ попадает только то, что перечислено в контракте постановки. Ни дат
согласий и принятия правил, ни `trial_ends_at`, ни `password_hash` здесь нет
намеренно: список отдаёт персональные данные всех учётных записей платформы
закрытому контуру, и лишнего в нём быть не должно.

Тело правки — только `full_name`. Email в проекте и есть логин, роль решается
отдельно (#100), а `is_active` значит «кабинет не активирован», а не
«заблокирован», поэтому менять его из кабинета оператора нечем. Правило и текст
отказа «ФИО не может быть пустым» берутся из `app/schemas/user.py`: копия
неминуемо разошлась бы с регистрацией и приглашением.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.user import normalize_full_name


class PlatformUser(BaseModel):
    """Строка реестра учётных записей платформы.

    `organization_id`, `organization_name` и `role` бывают `null` вместе: у
    пользователя без организации нет ни её названия, ни строки членства, а
    значит и роли. Роль лежит в `organization_members`, а не в `users`:
    связка «пользователь — организация» — это `active_organization_id` плюс
    строка членства по этой паре.
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
    """Страница списка: элементы и общее число пользователей по тем же условиям.

    `total` считается отдельным запросом и не зависит от `limit`/`offset`: по
    нему фронт понимает, есть ли ещё страница, — пока `len(items) < total`,
    «Показать ещё» видна.
    """

    items: list[PlatformUser]
    total: int = Field(examples=[61])


class PlatformUserUpdate(BaseModel):
    """Тело правки: единственное поле — ФИО.

    `extra="forbid"`: лишнее поле, в том числе `email`, — это `422`, а не
    молча проигнорированная попытка правки логина. Значение схлопывается по
    пробелам тем же помощником, что и при регистрации.
    """

    model_config = ConfigDict(extra="forbid")

    full_name: str = Field(min_length=1, max_length=255)

    @field_validator("full_name")
    @classmethod
    def validate_full_name(cls, value: str) -> str:
        return normalize_full_name(value)


class ImpersonationLink(BaseModel):
    """Ссылка входа под пользователем — то, что кабинет открывает в браузере.

    `url` абсолютный и собирается здесь, а не в кабинете: адрес сайта знает
    только основной API (`frontend_base_url`), и второй его экземпляр в кабинете
    разошёлся бы с оригиналом на первой же правке. Клиент переходит по ссылке
    целиком и своих адресов не строит.
    """

    url: str = Field(examples=["http://localhost:8080/su/eyJhbGciOiJIUzI1NiJ9.eyJ"])
