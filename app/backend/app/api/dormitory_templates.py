"""Снимки структуры общежития: библиотека шаблонов организации."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, SubscribedUser, own_dormitory
from app.api.organization import Membership
from app.db import get_db
from app.dormitory_templates import own_template, take_snapshot, visible_templates
from app.models.dormitory_template import DormitoryTemplate

router = APIRouter(
    prefix="/dormitory-templates",
    tags=["dormitory-templates"],
    responses={**SUBSCRIBED_USER_RESPONSES},
)
DbSession = Annotated[Session, Depends(get_db)]


class SaveTemplate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    dormitory_id: int = Field(ge=1)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value or "\x00" in value:
            raise ValueError("Укажите название шаблона")
        return value


def response(template: DormitoryTemplate, detail: bool = False) -> dict[str, Any]:
    result = {
        "id": template.id,
        "name": template.name,
        "created_at": template.created_at,
        "tab_count": sum(state != "deleted" for state in template.snapshot["sections"].values())
        + len(template.snapshot["tabs"]),
    }
    if detail:
        result["snapshot"] = template.snapshot
    return result


@router.get("")
def listing(_user: SubscribedUser, membership: Membership, db: DbSession) -> list[dict[str, Any]]:
    """Библиотека организации: только её собственные снимки структуры."""
    return [
        response(item)
        for item in db.scalars(
            visible_templates(membership.organization_id).order_by(
                DormitoryTemplate.name, DormitoryTemplate.id
            )
        )
    ]


@router.get("/{template_id}")
def read(
    template_id: int, _user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    template = own_template(db, template_id, membership.organization_id)
    return response(template, True)


@router.post("", status_code=201)
def create(
    payload: SaveTemplate,
    user: SubscribedUser,
    membership: Membership,
    db: DbSession,
) -> dict[str, Any]:
    # Снимок снимается с чужой структуры, поэтому родитель проверяется до снятия:
    # чужое общежитие — тот же 404, что и несуществующее.
    own_dormitory(db, payload.dormitory_id, membership)
    template = DormitoryTemplate(
        name=payload.name,
        created_by_id=user.id,
        organization_id=membership.organization_id,
        snapshot=take_snapshot(db, payload.dormitory_id),
    )
    db.add(template)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Шаблон с таким названием уже существует") from None
    db.refresh(template)
    return response(template)


@router.delete("/{template_id}", status_code=204)
def remove(template_id: int, _user: SubscribedUser, membership: Membership, db: DbSession) -> None:
    template = own_template(db, template_id, membership.organization_id)
    db.delete(template)
    db.commit()
