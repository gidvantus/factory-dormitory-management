"""Настройки общих и личных полей плана заездов."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ArrivalSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ArrivalField(ArrivalSchema):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    label: str = Field(min_length=1, max_length=80)
    type: Literal["text", "number", "date", "time", "checkbox", "select", "textarea"]
    scope: Literal["arrival", "person"] = "arrival"
    required: bool = False
    inForm: bool = True
    options: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def valid_field(self) -> "ArrivalField":
        if self.id == "names" or "\x00" in self.label:
            raise ValueError("Недопустимое название или идентификатор поля")
        self.label = " ".join(self.label.split())
        if self.required and not self.inForm:
            raise ValueError("Скрытое поле не может быть обязательным")
        if any(not value.strip() or len(value) > 120 or "\x00" in value for value in self.options):
            raise ValueError("Вариант списка должен содержать от 1 до 120 символов")
        self.options = list(dict.fromkeys(value.strip() for value in self.options))
        if self.type == "select" and not self.options:
            raise ValueError("Добавьте варианты выпадающего списка")
        return self


class ArrivalDisplay(ArrivalSchema):
    order: list[str] = Field(max_length=41)
    visible: list[str] = Field(max_length=41)
    summary: bool = True
    hideEmpty: bool = True
    compact: bool = False
    namesLimit: int = Field(default=3, ge=1, le=10000, strict=True)


class ArrivalSettingsInput(ArrivalSchema):
    revision: int = Field(ge=0, strict=True)
    fields: list[ArrivalField] = Field(max_length=40)
    display: ArrivalDisplay

    @model_validator(mode="after")
    def valid_settings(self) -> "ArrivalSettingsInput":
        ids = [field.id for field in self.fields]
        labels = [field.label.casefold() for field in self.fields]
        reserved = {"общежитие", "дата заезда", "количество человек", "фио"}
        if len(set(ids)) != len(ids) or len(set(labels)) != len(labels) or reserved & set(labels):
            raise ValueError("Названия и идентификаторы полей должны отличаться")
        expected = {"names", *ids}
        if set(self.display.order) != expected or len(self.display.order) != len(expected):
            raise ValueError("Порядок должен содержать все поля ровно один раз")
        if not set(self.display.visible) <= expected or len(set(self.display.visible)) != len(
            self.display.visible
        ):
            raise ValueError("Проверьте видимые поля правой панели")
        return self
