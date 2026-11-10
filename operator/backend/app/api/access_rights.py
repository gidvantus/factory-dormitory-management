"""Права доступа: сессия оператора и прокси к настройкам основного API."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app.main_api import (
    GATEWAY_RESPONSES,
    UNAUTHORIZED_RESPONSES,
    MainApiClient,
    call,
)
from app.schemas import ForwardedBody
from app.security import CurrentOperator

router = APIRouter(
    prefix="/access-rights",
    tags=["access-rights"],
    responses={**UNAUTHORIZED_RESPONSES, **GATEWAY_RESPONSES},
)
MAIN_PATH = "/api/platform/access-rights"


class RolePermissionResponse(BaseModel):
    role: Literal["manager", "admin", "commandant"]
    import_enabled: bool
    export_enabled: bool


@router.get("", response_model=list[RolePermissionResponse])
def read_access_rights(
    _operator: CurrentOperator, client: MainApiClient
) -> list[RolePermissionResponse]:
    response = call(client, "GET", MAIN_PATH)
    return [RolePermissionResponse.model_validate(item) for item in response.json()]


@router.patch("/{role}", response_model=RolePermissionResponse)
def update_access_rights(
    role: str,
    payload: ForwardedBody,
    _operator: CurrentOperator,
    client: MainApiClient,
) -> RolePermissionResponse:
    response = call(client, "PATCH", f"{MAIN_PATH}/{role}", json=payload.forwarded())
    return RolePermissionResponse.model_validate(response.json())
