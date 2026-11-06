"""Схемы запросов и ответов кабинета оператора.

Это и есть контракт с фронтендом: сюда попадает только то, что видно снаружи.
Успех входа, «кто вошёл» и отказ описываются этими моделями, поэтому схема
OpenAPI (`/openapi.json` и `/docs`) собирается из них, а не из документации
рядом.
"""

from datetime import date, datetime
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

    **`quantity` — копия поля основного API, а не своё.** У счёта за места
    (`item_kind = "seats"`) это число докупленных мест, у тарифа и решения —
    `null` («количество неприменимо»). Поле объявлено здесь явно: модель — ручная
    копия `PlatformInvoice` основного API, а pydantic лишние для модели поля
    молча отбрасывает, поэтому без этой строки реестр оператора показывал бы счёт
    за 100 мест так же, как за одно.
    """

    id: int
    number: str
    status: InvoiceStatus
    status_label: str
    item_kind: InvoiceItemKind
    # Сколько мест докуплено: `null` у тарифа и решения.
    quantity: int | None
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


# --- Тарифы платформы --------------------------------------------------------
# Те же правила, что у трёх предыдущих разделов: модель повторяет форму ответа
# основного API (`TariffResponse` из `app/backend/app/schemas/tariff.py`) один в
# один, а тело правки проверяется там же, наверху. `amount` едет строкой
# (`"4900.00"`), `price_label` собирает основной API — кабинет его не считает.


class Tariff(BaseModel):
    """Строка прайса в кабинете оператора.

    Поля — ровно `TariffResponse` основного API, включая скрытые от покупателя
    признаки яруса (`tooltip`, `group_code`) и `position`: кабинет показывает
    прайс целиком, в том числе строки со `is_visible = false`.

    `max_members = null` — «без ограничения», а не «ноль мест».
    """

    id: int
    name: str
    description: str | None
    amount: str
    currency: str
    period: str
    unit_label: str | None
    position: int
    is_visible: bool
    max_members: int | None
    tooltip: str | None
    group_code: str | None
    price_label: str


class UpdateTariffRequest(ForwardedBody):
    """Тело правки тарифа — то, что кабинет передаёт основному API.

    Поля необязательны, и уходят только присланные: `PATCH` одного описания не
    обнуляет цену. Значения не проверяются здесь вовсе — пустое название,
    отрицательная цена, слишком большая цена, неизвестный период и
    отрицательное количество пользователей отсекает основной API, и его `422`
    уходит клиенту дословно. Вторая копия правил и текстов разошлась бы с
    оригиналом на первой же правке.
    """

    name: str | None = None
    description: str | None = None
    amount: str | None = None
    period: str | None = None
    max_members: int | None = None
    is_visible: bool | None = None


# --- Реквизиты поставщика ----------------------------------------------------
# Те же правила, что у четырёх предыдущих разделов: модель повторяет форму ответа
# основного API (`CompanyDetailsResponse` из
# `app/backend/app/schemas/company_details.py`) один в один, а тело правки
# проверяется там же, наверху. Кабинет не переименовывает и не сокращает поля:
# иначе фронтенд знал бы два контракта на одни и те же данные.
#
# `updated_at` бывает `null`: пока строки реквизитов нет, момента правки у неё
# тоже нет, и `null` — честный ответ, а не «сейчас».


class CompanyDetails(BaseModel):
    """Реквизиты поставщика в кабинете оператора.

    Одиннадцать полей плюс `id` и `updated_at` — ровно форма ответа основного
    API. Пустое значение приходит как `null`: `null` и пустая строка для
    реквизитов означают одно и то же — «поле не заполнено», — и экран не выводит
    прочерк вместо пустого поля.
    """

    id: int
    name: str | None
    inn: str | None
    kpp: str | None
    ogrn: str | None
    address: str | None
    bank_name: str | None
    bank_bic: str | None
    bank_account: str | None
    corr_account: str | None
    signatory: str | None
    vat_note: str | None
    updated_at: datetime | None


class UpdateCompanyDetailsRequest(ForwardedBody):
    """Тело правки реквизитов поставщика — то, что кабинет передаёт основному API.

    Поля необязательны, и уходят только присланные: `PATCH` одной строки про НДС
    не обнуляет банк. Значения не проверяются здесь вовсе — формат ИНН, КПП,
    ОГРН, БИК и счетов, длины колонок и очистка поля пустой строкой это правило
    основного API, и его `422` уходит клиенту дословно. Вторая копия правил и
    текстов разошлась бы с оригиналом на первой же правке.
    """

    name: str | None = None
    inn: str | None = None
    kpp: str | None = None
    ogrn: str | None = None
    address: str | None = None
    bank_name: str | None = None
    bank_bic: str | None = None
    bank_account: str | None = None
    corr_account: str | None = None
    signatory: str | None = None
    vat_note: str | None = None


# --- Решения магазина --------------------------------------------------------
# Те же правила, что у остальных разделов платформенного контура: модель
# повторяет форму ответа основного API (`SolutionAdminResponse` из
# `app/backend/app/schemas/platform_solution.py`) один в один, а тело правки
# проверяется там же, наверху. `amount` едет строкой (`"500.00"`), `price_label`
# собирает основной API — кабинет его не считает.
#
# `code` есть только в ответе: это машинное имя решения и гейт платной функции
# (`app.solutions.has_solution`), поэтому правке оно не подлежит и в теле
# отсутствует. Строка каталога заводится миграцией: создания из кабинета нет.


class Solution(BaseModel):
    """Строка каталога решений в кабинете оператора.

    Поля — ровно `SolutionAdminResponse` основного API: кабинет показывает
    каталог целиком, в том числе строки со `is_visible = false` («не в
    каталоге»). `position` — порядок витрины магазина: меньше — выше, ничья
    решается `id`.
    """

    id: int
    code: str
    name: str
    description: str | None
    amount: str
    currency: str
    position: int
    is_visible: bool
    price_label: str
    created_at: datetime
    updated_at: datetime


class UpdateSolutionRequest(ForwardedBody):
    """Тело правки решения — то, что кабинет передаёт основному API.

    Поля необязательны, и уходят только присланные: `PATCH` одного описания не
    обнуляет цену.

    **Периода оплаты нет** (#195): у решения нет собственного срока, право
    действует, пока действует тариф организации. Присланный `period` основной API
    отсекает как лишнее поле (`422`), и второй копии этого правила здесь нет.

    **Типы полей здесь `Any`, а не `str`/`int`/`bool`, намеренно** (доработка по
    ревью №1, #188). С `int | None` в `position` и `bool | None` в `is_visible`
    `pydantic` приводил присланное до отправки: `"3"` и `true` становились числом
    и уходили наверх как `3` и `1`, `1` становился `true`, — и кабинет отвечал
    `200` там, где основной API отвечает `422`; а на `1.5` и `"да"` клиент получал
    английский текст `pydantic` вместо русского текста контракта. Фронтенд вешает
    `aria-invalid` на поле, названное в `detail`, поэтому текст обязан приходить
    из основного API.

    Проверять и приводить значения — работа основного API: пустое название,
    отрицательную или слишком большую цену, валюту не из трёх заглавных букв,
    нецелый порядок и состояние не `true`/`false` отсекает он, и его `422` уходит
    клиенту дословно. Вторая копия правил и текстов разошлась бы с оригиналом на
    первой же правке.
    """

    name: Any = None
    description: Any = None
    amount: Any = None
    currency: Any = None
    position: Any = None
    is_visible: Any = None


# --- Тариф и расширения организации ------------------------------------------
# Девятый раздел кабинета (#189). Те же правила, что у остальных платформенных
# разделов: модели повторяют форму ответа основного API
# (`app/backend/app/schemas/platform_subscription.py`) один в один, а тела правки
# проверяются там же, наверху. Кабинет ничего не добавляет и ничего не считает:
# `paid_until`, `days_left` и `is_live` приходят готовыми, из основного API.


class SubscriptionTariff(BaseModel):
    """Записанный слот подписки: строка прайса и её срок.

    `ends_at: null` — бессрочный тариф (тогда и `paid_until: null`), `is_live`
    считает сервер по сроку. `price_label` — готовая подпись цены, её тоже
    собирает сервер: второй формулы цены на клиенте нет.
    """

    id: int
    name: str
    period: str
    max_members: int | None
    price_label: str
    ends_at: datetime | None
    paid_until: date | None
    is_live: bool


class NextSubscription(BaseModel):
    """Оплаченный вперёд слот: показывается, но не правится и не снимается."""

    tariff: SubscriptionTariff
    ends_at: datetime | None
    paid_until: date | None


class SubscriptionRight(BaseModel):
    """Право организации на расширение — включая истёкшие (`is_live = false`).

    `code` — машинный код решения, гейт платной функции; `paid_until` — последний
    включённый день права по Москве (`null` — бессрочное).
    """

    code: str
    name: str
    expires_at: datetime | None
    paid_until: date | None
    is_live: bool


class SubscriptionState(BaseModel):
    """Состояние подписки организации — один и тот же объект у всех четырёх ручек.

    `tariff` — записанный текущий слот, без «виртуального переезда» наступившего
    будущего периода: оператор видит то, что лежит в базе. `member_limit` —
    **действующий** предел мест: `max_members` действующего тарифа плюс
    `extra_seats` (`null` — без ограничения). Считает его основной API тем же
    правилом, что проверка приглашений и клиентский кабинет, поэтому у истёкшего
    слота с оплаченным следующим кабинет покажет предел будущего тарифа.
    """

    tariff: SubscriptionTariff | None
    days_left: int
    next: NextSubscription | None
    extra_seats: int
    member_limit: int | None
    solutions: list[SubscriptionRight]


class UpdateSubscriptionRequest(ForwardedBody):
    """Тело правки срока — то, что кабинет передаёт основному API.

    Поле объявлено `Any`, а не `str`, намеренно — по той же причине, что у
    `UpdateSolutionRequest`: с `str` `pydantic` отклонил бы присланное число или
    `null` своим английским текстом, а контракт обещает, что отказ приходит из
    основного API по-русски («Укажите срок действия в формате ГГГГ-ММ-ДД»).
    Кабинет значения не проверяет: он их только передаёт.
    """

    paid_until: Any = None
