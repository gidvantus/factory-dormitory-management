"""Библиотека снимков структуры общежития."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.dormitory_templates import take_snapshot
from app.models.dormitory_template import DormitoryTemplate
from app.security import ACTIVE_USER_RESPONSES, ActiveUser

router = APIRouter(
    prefix="/dormitory-templates", tags=["dormitory-templates"], responses={**ACTIVE_USER_RESPONSES}
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
def listing(_user: ActiveUser, db: DbSession) -> list[dict[str, Any]]:
    return [
        response(item)
        for item in db.scalars(
            select(DormitoryTemplate).order_by(DormitoryTemplate.name, DormitoryTemplate.id)
        )
    ]


@router.get("/{template_id}")
def read(template_id: int, _user: ActiveUser, db: DbSession) -> dict[str, Any]:
    template = db.get(DormitoryTemplate, template_id)
    if template is None:
        raise HTTPException(404, "Шаблон не найден")
    return response(template, True)


@router.post("", status_code=201)
def create(payload: SaveTemplate, user: ActiveUser, db: DbSession) -> dict[str, Any]:
    template = DormitoryTemplate(
        name=payload.name, created_by_id=user.id, snapshot=take_snapshot(db, payload.dormitory_id)
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
def remove(template_id: int, _user: ActiveUser, db: DbSession) -> None:
    template = db.get(DormitoryTemplate, template_id)
    if template is None:
        raise HTTPException(404, "Шаблон не найден")
    db.delete(template)
    db.commit()
