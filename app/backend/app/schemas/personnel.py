"""Входные данные раздела персонала."""

from datetime import date as CalendarDate
from typing import Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    field_validator,
    model_validator,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class IdentityFields(StrictModel):
    full_name: str | None = Field(default=None, max_length=255)
    personnel_number: str | None = Field(default=None, max_length=40)
    phone: str | None = Field(default=None, max_length=30)

    @field_validator("full_name", "personnel_number", "phone")
    @classmethod
    def nonempty(cls, value: str | None) -> str | None:
        return value or None


class IdentityChoice(IdentityFields):
    mode: Literal["existing", "new", "pending"]
    employee_id: UUID | None = None
    check_token: str = Field(min_length=64, max_length=64)

    @model_validator(mode="after")
    def valid_choice(self) -> "IdentityChoice":
        if self.mode == "existing" and not self.employee_id:
            raise ValueError("Выберите существующую карточку")
        if self.mode != "existing" and not any((self.full_name, self.personnel_number, self.phone)):
            raise ValueError("Укажите хотя бы ФИО, табельный номер или телефон")
        return self


class RecordCreate(StrictModel):
    dormitory_id: int = Field(ge=1)
    table_key: str = Field(pattern=r"^(residents|inflow|outflow|archive|custom_[1-9][0-9]*)$")
    identity: IdentityChoice
    values: dict[str, Any] = Field(default_factory=dict)
    entry_columns: dict[Literal["full_name", "phone"], int] | None = None


class RecordLink(StrictModel):
    dormitory_id: int = Field(ge=1)
    table_key: str = Field(pattern=r"^(residents|inflow|outflow|archive|custom_[1-9][0-9]*)$")
    row_id: int = Field(ge=1)
    identity: IdentityChoice


class EmployeeUpdate(IdentityFields):
    identity_status: Literal["pending", "confirmed"] = "confirmed"


class NoteInput(StrictModel):
    text: str = Field(min_length=1, max_length=1500)


class ArrivalPerson(StrictModel):
    id: UUID
    full_name: str = Field(default="", max_length=255)
    custom_values: dict[str, StrictStr | StrictBool] = Field(default_factory=dict, max_length=240)

    @field_validator("full_name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("Недопустимый символ в ФИО")
        return " ".join(value.split())


class ArrivalInput(StrictModel):
    date: CalendarDate
    dormitory_id: int = Field(ge=1)
    count: int = Field(ge=1, le=10000, strict=True)
    names: list[str] = Field(default_factory=list, max_length=10000)
    people: list[ArrivalPerson] | None = Field(default=None, max_length=10000)
    custom_values: dict[str, StrictStr | StrictBool] = Field(default_factory=dict, max_length=240)
    settings_revision: int | None = Field(default=None, ge=0, strict=True)

    @field_validator("names")
    @classmethod
    def valid_names(cls, names: list[str]) -> list[str]:
        normalized = [" ".join(name.split()) for name in names]
        if any(not name or len(name) > 255 or "\x00" in name for name in normalized):
            raise ValueError("Каждое ФИО должно содержать от 1 до 255 символов")
        return normalized

    @model_validator(mode="after")
    def valid_count(self) -> "ArrivalInput":
        if len(self.names) > self.count:
            raise ValueError("Количество ФИО не должно превышать количество приезжающих")
        if self.people is not None:
            if len(self.people) != self.count:
                raise ValueError("Число строк людей должно совпадать с количеством человек")
            if len({person.id for person in self.people}) != len(self.people):
                raise ValueError("Идентификаторы людей должны отличаться")
            names = [person.full_name for person in self.people if person.full_name]
            if "names" in self.model_fields_set and self.names != names:
                raise ValueError("ФИО должны совпадать со строками людей")
            self.names = names
            if self.settings_revision is None:
                raise ValueError("Передайте ревизию настроек полей")
        return self


class ArrivalUpdate(ArrivalInput):
    revision: int = Field(ge=0)


class PlanInput(StrictModel):
    date: CalendarDate
    end: CalendarDate
    dormitory_id: int = Field(ge=1)
    confirmed: bool = False
    comment: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def valid_dates(self) -> "PlanInput":
        if self.end < self.date:
            raise ValueError("Окончание вахты должно быть не раньше заезда")
        return self


class PlanUpdate(StrictModel):
    confirmed: bool


class BindingInput(StrictModel):
    fields: dict[
        Literal["full_name", "personnel_number", "phone", "shift_start", "shift_end", "reason"], int
    ]
    convert_phone_to_text: bool = False


ListFilter = Literal["all", "current", "ending"]


class EmployeeColumnFilter(StrictModel):
    field: str = Field(min_length=1, max_length=255)
    operator: Literal["contains", "equals", "empty", "filled", "from", "to"]
    value: str = Field(default="", max_length=255)

    @field_validator("field")
    @classmethod
    def supported_field(cls, value: str) -> str:
        if value == "shift_decision":
            raise ValueError("Фильтр по решению об окончании вахты больше не поддерживается")
        return value


class PersonnelExportInput(StrictModel):
    name: str = Field(default="Выбранные сотрудники", min_length=1, max_length=120)
    employee_ids: list[UUID] = Field(min_length=1, max_length=5000)
    columns: list[list[int]] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def export_limits(self) -> "PersonnelExportInput":
        if len(set(self.employee_ids)) != len(self.employee_ids):
            raise ValueError("Сотрудники в выгрузке не должны повторяться")
        if any(not ids or len(ids) > 1000 or any(id < 1 for id in ids) for ids in self.columns):
            raise ValueError("Некорректный столбец выгрузки")
        return self


class SavedList(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    filter: ListFilter = "all"
    dormitory: int | None = Field(default=None, ge=1)
    days: int = Field(default=5, ge=1, le=365)
    query: str = Field(default="", max_length=255)
    scope: list[int] = Field(default_factory=list, max_length=1000)
    column_filters: list[EmployeeColumnFilter] = Field(default_factory=list, max_length=10)


class Block(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    kind: Literal["residents", "ending", "contacts", "plans", "saved"]
    title: str = Field(min_length=1, max_length=120)
    scope: list[int] = Field(default_factory=list, max_length=1000)
    days: int = Field(default=5, ge=1, le=365)
    limit: int = Field(default=4, ge=1, le=20)
    wide: bool = False
    saved_list_id: str | None = Field(default=None, max_length=80)


class PreferencesInput(StrictModel):
    revision: int = Field(ge=0)
    blocks: list[Block] = Field(max_length=20)
    lists: list[SavedList] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def unique_ids(self) -> "PreferencesInput":
        for values in (self.blocks, self.lists):
            if len({item.id for item in values}) != len(values):
                raise ValueError("Идентификаторы элементов должны быть уникальны")
        if any(id < 1 for block in self.blocks for id in block.scope) or any(
            id < 1 for item in self.lists for id in item.scope
        ):
            raise ValueError("Некорректное общежитие в блоке")
        return self
