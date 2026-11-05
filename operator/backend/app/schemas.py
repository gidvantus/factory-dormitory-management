"""Схемы запросов и ответов кабинета оператора.

Это и есть контракт с фронтендом: сюда попадает только то, что видно снаружи.
Успех входа, «кто вошёл» и отказ описываются этими моделями, поэтому схема
OpenAPI (`/openapi.json` и `/docs`) собирается из них, а не из документации
рядом.
"""

from datetime import datetime
from typing import Any, Literal

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


# --- Счета платформы ---------------------------------------------------------
# Те же правила, что у организаций и пользователей: модели повторяют форму
# ответа основного API один в один, а тела правки проверяются там же, наверху.
# Набор полей строки счёта — это `PlatformInvoice` основного API
# (`app/backend/app/schemas/platform_invoice.py`), наследующий ответ кабинета
# клиента; кабинет его не переименовывает и не сокращает.

# Статусы счёта. Набор тот же, что объявляет основной API и держит `CHECK` в
# таблице `invoices`; значение приходит с сервера и уходит в браузер дословно.
InvoiceStatus = Literal["new", "paid", "closed", "cancelled"]

# Вид предмета счёта: тариф, решение магазина улучшений или докупленные сверх
# тарифа места (`seats`, #168). Набор обязан совпадать с основным API: без
# третьего значения счёт за места не прошёл бы проверку схемы, и кабинет
# оператора отвечал бы `500` вместо строки реестра.
InvoiceItemKind = Literal["tariff", "solution", "seats"]


class PlatformInvoice(BaseModel):
    """Строка реестра счетов платформы: счёт плюс организация, которой он выставлен.

    `amount` едет строкой (`"10000.00"`), а не числом: копейки не должны
    теряться на округлении. Готовые подписи `amount_label` и `status_label`
    собирает основной API — кабинет их не пересчитывает.

    `organization_name` бывает `null` у пустой заготовки организации.
    `can_manage` в платформенном контуре всегда `true`: право даёт сервисный
    токен, ролей организации здесь нет, и фронт на это поле не ветвится.
    """

    id: int
    number: str
    status: InvoiceStatus
    status_label: str
    item_kind: InvoiceItemKind
    amount: str
    currency: str
    amount_label: str
    tariff_name: str | None
    tariff_period: str | None
    buyer_name: str | None
    buyer_inn: str | None
    buyer_kpp: str | None
    buyer_ogrn: str | None
    buyer_address: str | None
    has_act: bool
    can_manage: bool
    paid_at: datetime | None
    created_at: datetime
    organization_id: int
    organization_name: str | None


class PlatformInvoicePage(BaseModel):
    """Страница списка: элементы и общее число счетов по тем же условиям.

    Пока `len(items) < total`, у списка есть что догружать.
    """

    items: list[PlatformInvoice]
    total: int


class UpdateInvoiceStatusRequest(ForwardedBody):
    """Тело смены статуса счёта — то, что кабинет передаёт основному API.

    Единственное поле и никаких проверок: набор допустимых статусов и
    разрешённые переходы живут в основном API (`app/backend/app/invoice_status.py`),
    и его `409`/`422` уходят клиенту дословно. Вторая копия правил здесь
    разошлась бы с оригиналом на первой же правке.
    """

    status: str | None = None
