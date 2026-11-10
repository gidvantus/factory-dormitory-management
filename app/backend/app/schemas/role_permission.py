"""Контракт прав доступа и правки одного или двух чекбоксов."""

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, StrictBool, model_validator

AccessRole = Literal["manager", "admin", "commandant"]


class ExchangePermissions(BaseModel):
    import_enabled: bool
    export_enabled: bool


class RolePermissionResponse(ExchangePermissions):
    model_config = ConfigDict(from_attributes=True)

    role: AccessRole


class UpdateRolePermissionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Правится только присланное поле: второй чекбокс не перезаписывается.
    import_enabled: StrictBool = True
    export_enabled: StrictBool = True

    @model_validator(mode="after")
    def require_change(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("Укажите право, которое нужно изменить")
        return self
