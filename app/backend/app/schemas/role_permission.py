"""Контракт прав разделов, обмена данными и независимой правки чекбоксов."""

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, StrictBool, model_validator

AccessRole = Literal["manager", "admin", "commandant"]


class ExchangePermissions(BaseModel):
    import_enabled: bool
    export_enabled: bool
    overview_enabled: bool = True
    dormitories_enabled: bool = True
    personnel_enabled: bool = True
    statistics_enabled: bool = True
    documents_enabled: bool = True
    shop_enabled: bool = True
    organization_enabled: bool = True
    members_enabled: bool = True
    profile_enabled: bool = True


class RolePermissionResponse(ExchangePermissions):
    model_config = ConfigDict(from_attributes=True)

    role: AccessRole


class UpdateRolePermissionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Правятся только присланные поля: остальные чекбоксы не перезаписываются.
    import_enabled: StrictBool = True
    export_enabled: StrictBool = True
    overview_enabled: StrictBool = True
    dormitories_enabled: StrictBool = True
    personnel_enabled: StrictBool = True
    statistics_enabled: StrictBool = True
    documents_enabled: StrictBool = True
    shop_enabled: StrictBool = True
    organization_enabled: StrictBool = True
    members_enabled: StrictBool = True
    profile_enabled: StrictBool = True

    @model_validator(mode="after")
    def require_change(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("Укажите право, которое нужно изменить")
        return self
