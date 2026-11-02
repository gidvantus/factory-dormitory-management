"""Строгая схема конструктора: сохраняются правила и ручные значения, а не расчёты."""

import json
from datetime import date
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    field_validator,
    model_validator,
)

from app.schemas.custom_tab import TabOptions
from app.schemas.personnel import Block, EmployeeColumnFilter

Identifier = Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[\w:.-]+$")]
ColumnKind = Literal["employee", "text", "number", "date", "select", "checkbox"]
Scalar = StrictStr | StrictBool


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class LinkFilter(StrictModel):
    field: str = Field(min_length=1, max_length=255)
    operator: Literal["equals", "contains", "not_empty", "empty", "from", "to"]
    value: str = Field(default="", max_length=2000)


class Match(StrictModel):
    sourceField: str = Field(min_length=1, max_length=255)
    localColumnId: Identifier


class Link(StrictModel):
    sourceId: str = Field(min_length=1, max_length=255)
    operation: Literal["lookup", "count", "sum", "average", "min", "max"]
    valueField: str = Field(default="", max_length=255)
    sourceRowId: str | None = Field(default=None, max_length=80)
    match: Match | None = None
    filters: list[LinkFilter] = Field(default_factory=list, max_length=10)
    dateField: str | None = Field(default=None, max_length=255)
    empty: Literal["zero", "blank", "error"] = "zero"


class Rule(StrictModel):
    mode: Literal["manual", "formula", "link"] = "manual"
    expression: str = Field(default="=", max_length=1000)
    refs: dict[str, Identifier] = Field(default_factory=dict, max_length=100)
    link: Link | None = None


class ManualSettings(StrictModel):
    kind: ColumnKind
    required: bool


class Column(StrictModel):
    id: Identifier
    name: str = Field(default="", max_length=255)
    kind: ColumnKind
    options: list[Annotated[str, Field(max_length=255)]] = Field(
        default_factory=list, max_length=100
    )
    required: bool = False
    archived: bool = False
    rule: Rule | None = None
    manualSettings: ManualSettings | None = None


class Row(StrictModel):
    id: Identifier
    values: dict[Identifier, Scalar] = Field(default_factory=dict, max_length=100)
    dayValues: dict[str, str] = Field(default_factory=dict, max_length=3660)
    name: str | None = Field(default=None, max_length=100)
    rule: Rule | None = None
    includeInTotals: bool = True

    @model_validator(mode="after")
    def valid_values(self) -> "Row":
        for value in self.values.values():
            if isinstance(value, str) and (len(value) > 2000 or "\x00" in value):
                raise ValueError(
                    "Значение ячейки длиннее 2000 символов или содержит нулевой символ"
                )
        for key, value in self.dayValues.items():
            if date.fromisoformat(key).isoformat() != key or len(value) > 2000:
                raise ValueError("Проверьте дату и значение дневной ячейки")
        return self


class Criteria(StrictModel):
    filter: Literal["all", "current", "ending"] = "all"
    dormitory: int | None = Field(default=None, ge=1)
    days: int = Field(default=7, ge=1, le=365)
    query: str = Field(default="", max_length=255)
    scope: list[int] = Field(default_factory=list, max_length=1000)
    column_filters: list[EmployeeColumnFilter] = Field(default_factory=list, max_length=10)


class Actions(StrictModel):
    search: bool = True
    filters: bool = True
    export: bool = True
    add: bool = True
    remove: bool = True


class Tab(StrictModel):
    id: Identifier
    name: str = Field(min_length=1, max_length=60)
    description: str = Field(default="", max_length=180)
    kind: Literal["employees", "table", "blocks"]
    builtin: Literal[False] = False
    hidden: bool = False
    archived: bool = False
    parentId: Identifier | None = None
    isGroup: bool = False
    tableOptions: TabOptions = Field(default_factory=TabOptions)
    dateColumnId: Identifier | None = None
    criteria: Criteria = Field(default_factory=Criteria)
    fields: list[str] = Field(default_factory=list, max_length=100)
    columns: list[Column] = Field(default_factory=list, max_length=100)
    rows: list[Row] = Field(default_factory=list, max_length=5000)
    blocks: list[Block] = Field(default_factory=list, max_length=20)
    actions: Actions = Field(default_factory=Actions)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        if not value.strip() or "\x00" in value:
            raise ValueError("Укажите название подвкладки")
        return value.strip()


class BuilderState(StrictModel):
    version: Literal[3] = 3
    tabs: list[Tab] = Field(default_factory=list, max_length=100)
    defaultTab: Identifier = "workspace"

    @model_validator(mode="after")
    def payload_size(self) -> "BuilderState":
        if len(json.dumps(self.model_dump(), ensure_ascii=False).encode()) > 8_000_000:
            raise ValueError("Данные конструктора превышают 8 МБ")
        return self


class SaveBuilder(StrictModel):
    revision: int = Field(ge=0)
    state: BuilderState


class Evaluation(StrictModel):
    state: BuilderState
    tabId: Identifier
    rowId: Identifier | None = None
    columnId: Identifier | None = None
    day: str | None = None
    from_date: date | None = Field(default=None, alias="from")
    to_date: date | None = Field(default=None, alias="to")

    @model_validator(mode="after")
    def period(self) -> "Evaluation":
        if self.day and date.fromisoformat(self.day).isoformat() != self.day:
            raise ValueError("Проверьте дату расчёта")
        if bool(self.from_date) != bool(self.to_date):
            raise ValueError("Укажите обе границы периода")
        if self.from_date and self.to_date and not 0 <= (self.to_date - self.from_date).days <= 365:
            raise ValueError("Выберите период от 1 до 366 дней")
        return self


def dump_state(state: BuilderState) -> dict[str, Any]:
    return state.model_dump(mode="json", by_alias=True, exclude_none=True)
