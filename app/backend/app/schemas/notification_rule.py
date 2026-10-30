"""Схемы конструктора правил уведомлений.

Контракт один: клиент читает каталог «таблица → столбцы → операторы», правит
правила и просит предпросмотр. Полей сообщения в схемах нет и быть не должно:
сообщение — это название правила, собранное сервером.

Ограничения здесь намеренно мягкие. Длину названия, потолок условий и
применимость оператора проверяет домен (`app/notification_rules.py`), и его
отказы — одна строка `detail`, которую фронт показывает дословно. Схема с
`max_length` вернула бы список ошибок Pydantic вместо текста контракта.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

# Оператор условия. Допустимые для конкретного столбца отдаёт каталог.
RuleOperator = Literal["equals", "not_equals", "greater", "less", "not_empty", "is_empty"]

# Типы столбцов, по которым можно строить условия. Совпадает с
# `app/notification_rules.py::RULE_COLUMN_KINDS`; `action`, `hostel` и архивные
# столбцы в каталог не попадают.
RuleColumnKind = Literal["text", "number", "date", "checkbox", "select"]


class RuleConditionRequest(BaseModel):
    """Условие правила: столбец, оператор и значение (кроме «заполнено/не заполнено»)."""

    column_id: int = Field(ge=1)
    operator: RuleOperator
    # `Any` вместо союза скаляров: чекбокс присылает `bool`, число — строку или
    # число, текст и дата — строку. Приведение к типу столбца делает домен.
    value: Any = None


class RuleRequest(BaseModel):
    """Тело `POST`/`PUT` правила. `dormitory_id` берётся только из пути.

    Если бы он был ещё и в теле, ручку пришлось бы закрывать отдельной
    проверкой принадлежности: инвентарный тест
    `tests/test_route_guard_inventory.py` ловит такие тела и требует гейт.
    """

    name: str
    table_key: str = Field(min_length=1, max_length=32)
    is_enabled: bool = True
    conditions: list[RuleConditionRequest] = Field(default_factory=list)


class RulePreviewRequest(BaseModel):
    """Тело предпросмотра: то же, что у правила, но без сохранения.

    Предпросмотр не проверяет `is_enabled`: текст сообщения от включённости не
    зависит, и клиент может проверить правило до его сохранения.
    """

    name: str
    table_key: str = Field(min_length=1, max_length=32)
    conditions: list[RuleConditionRequest] = Field(default_factory=list)


class RuleConditionResponse(BaseModel):
    """Условие в ответе: значение уже приведено к типу столбца."""

    column_id: int
    operator: str
    value: Any = None


class NotificationRuleResponse(BaseModel):
    """Правило в списке и в ответе на сохранение.

    `broken` — правило ссылается на удалённую таблицу или архивный столбец.
    Такое правило молчит при записи, но его видно в списке и можно удалить.
    `table_title` — человеческое название таблицы, потому что `table_key` нужен
    клиенту для запросов, а не для чтения.
    """

    id: int
    name: str
    table_key: str
    table_title: str
    is_enabled: bool
    conditions: list[RuleConditionResponse]
    broken: bool


class CatalogColumnResponse(BaseModel):
    """Столбец, доступный условию, и операторы, которые к нему подходят."""

    id: int
    name: str
    kind: RuleColumnKind
    operators: list[str]


class CatalogTableResponse(BaseModel):
    """Таблица общежития в каталоге конструктора."""

    key: str
    title: str
    columns: list[CatalogColumnResponse]


class RuleCatalogResponse(BaseModel):
    """Каталог конструктора: только таблицы этого общежития."""

    tables: list[CatalogTableResponse]


class RulePreviewResponse(BaseModel):
    """Предпросмотр: ровно тот текст, что уйдёт в Telegram, и число строк.

    `text` — `name` правила, когда под правило подходит хотя бы одна строка, и
    `None`, когда не подходит ни одна. Клиент показывает текст как есть и никогда
    не склеивает сообщение сам.
    """

    text: str | None
    matched: int
