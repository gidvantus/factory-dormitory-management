"""Общее оформление таблиц и личный масштаб."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.access import SUBSCRIBED_USER_RESPONSES, OwnDormitory, SubscribedUser
from app.api.organization import Membership
from app.db import get_db
from app.models.organization import Organization
from app.models.table_view import TableView
from app.models.user import User
from app.table_data import DEFAULT_COLUMNS, lock_dormitory, require_writable_table

# Роутер закрыт `SubscribedUser`, поэтому 403 объявляется один раз для всех маршрутов.
router = APIRouter(tags=["table-views"], responses={**SUBSCRIBED_USER_RESPONSES})
DbSession = Annotated[Session, Depends(get_db)]
ViewKey = Annotated[str, Path(min_length=1, max_length=120, pattern=r"^[\w.-]+$")]
Color = Literal[
    "mint", "sage", "sky", "blue", "lilac", "lavender", "butter", "sand", "peach", "rose"
]


class ViewState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rows: list[str] = Field(default_factory=list, max_length=20000)
    columns: list[str] = Field(default_factory=list, max_length=1000)
    row_colors: dict[str, Color] = Field(default_factory=dict, max_length=20000)
    column_colors: dict[str, Color] = Field(default_factory=dict, max_length=1000)

    @model_validator(mode="after")
    def valid_keys(self) -> "ViewState":
        for keys in (self.rows, self.columns, self.row_colors, self.column_colors):
            if any(not key or len(key) > 160 for key in keys):
                raise ValueError("Некорректный заголовок строки или столбца")
            if len(keys) != len(set(keys)):
                raise ValueError("Повторяющиеся заголовки")
        return self


class SaveView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    state: ViewState


class TableZoom(BaseModel):
    model_config = ConfigDict(extra="forbid")
    percent: int = Field(default=100, ge=50, le=200)


def personal_view_key(
    user: User, organization_id: int, scope: str, key: str
) -> tuple[int, str, str]:
    return organization_id, f"zoom:user-{user.id}:{scope}", key


def save_zoom(
    db: Session, user: User, identifier: tuple[int, str, str], payload: TableZoom
) -> TableZoom:
    db.scalar(select(User.id).where(User.id == user.id).with_for_update())
    row = db.get(TableView, identifier, populate_existing=True)
    if payload.percent == 100:
        if row is not None:
            db.delete(row)
    else:
        if row is None:
            organization_id, scope, key = identifier
            row = TableView(organization_id=organization_id, scope=scope, table_key=key)
            db.add(row)
        row.state = payload.model_dump()
    db.commit()
    return payload


@router.get("/dormitories/{dormitory_id}/table-views/{key}/zoom")
def read_dormitory_zoom(
    key: ViewKey, user: SubscribedUser, dorm: OwnDormitory, db: DbSession
) -> TableZoom:
    row = db.get(
        TableView, personal_view_key(user, dorm.organization_id, f"dormitory-{dorm.id}", key)
    )
    return TableZoom.model_validate(row.state) if row else TableZoom()


@router.put("/dormitories/{dormitory_id}/table-views/{key}/zoom")
def save_dormitory_zoom(
    key: ViewKey, payload: TableZoom, user: SubscribedUser, dorm: OwnDormitory, db: DbSession
) -> TableZoom:
    return save_zoom(
        db,
        user,
        personal_view_key(user, dorm.organization_id, f"dormitory-{dorm.id}", key),
        payload,
    )


@router.get("/personnel/table-views/{key}/zoom")
def read_personnel_zoom(
    key: ViewKey, user: SubscribedUser, membership: Membership, db: DbSession
) -> TableZoom:
    row = db.get(TableView, personal_view_key(user, membership.organization_id, "personnel", key))
    return TableZoom.model_validate(row.state) if row else TableZoom()


@router.put("/personnel/table-views/{key}/zoom")
def save_personnel_zoom(
    key: ViewKey, payload: TableZoom, user: SubscribedUser, membership: Membership, db: DbSession
) -> TableZoom:
    return save_zoom(
        db, user, personal_view_key(user, membership.organization_id, "personnel", key), payload
    )


def response(row: TableView | None) -> dict[str, Any]:
    return {
        "revision": row.revision if row else 0,
        "state": row.state if row else ViewState().model_dump(),
    }


def save(
    db: Session, organization_id: int, scope: str, key: str, payload: SaveView
) -> dict[str, Any]:
    db.scalar(select(Organization).where(Organization.id == organization_id).with_for_update())
    row = db.get(TableView, (organization_id, scope, key), populate_existing=True)
    if payload.revision != (row.revision if row else 0):
        raise HTTPException(
            409, "Оформление изменено в другом окне. Обновите оформление и повторите действие."
        )
    if row is None:
        row = TableView(organization_id=organization_id, scope=scope, table_key=key, revision=0)
        db.add(row)
    row.state = payload.state.model_dump()
    row.revision += 1
    db.commit()
    return response(row)


@router.get("/dormitories/{dormitory_id}/table-views/{key}")
def read_dormitory_view(
    key: ViewKey, _user: SubscribedUser, dorm: OwnDormitory, db: DbSession
) -> dict[str, Any]:
    return response(db.get(TableView, (dorm.organization_id, f"dormitory-{dorm.id}", key)))


@router.put("/dormitories/{dormitory_id}/table-views/{key}")
def save_dormitory_view(
    key: ViewKey, payload: SaveView, _user: SubscribedUser, dorm: OwnDormitory, db: DbSession
) -> dict[str, Any]:
    if key not in (*DEFAULT_COLUMNS, "report", "places") and not (
        key.startswith("custom_") and key[7:].isdigit()
    ):
        raise HTTPException(422, "Неизвестная рабочая таблица")
    lock_dormitory(db, dorm.id)
    db.scalar(select(Organization).where(Organization.id == dorm.organization_id).with_for_update())
    current = db.get(
        TableView, (dorm.organization_id, f"dormitory-{dorm.id}", key), populate_existing=True
    )
    if payload.revision != (current.revision if current else 0):
        raise HTTPException(
            409, "Оформление изменено в другом окне. Обновите оформление и повторите действие."
        )
    if key in ("report", "places"):
        from app.section_state import require_section_writable

        require_section_writable(db, dorm.id, key)
    else:
        require_writable_table(db, dorm.id, key)
        if payload.state.columns:
            from app.table_data import ensure_columns

            columns = ensure_columns(db, dorm.id, key)
            ranks = {value: index for index, value in enumerate(payload.state.columns)}
            ordered = sorted(
                columns, key=lambda col: (ranks.get(str(col.id), len(ranks) + col.position), col.id)
            )
            for position, column in enumerate(ordered):
                column.position = position
    if key == "report" and payload.state.rows:
        from app.models.report import ReportRow

        rows = list(
            db.scalars(
                select(ReportRow)
                .where(ReportRow.dormitory_id == dorm.id)
                .order_by(ReportRow.position, ReportRow.id)
            )
        )
        ranks = {value: index for index, value in enumerate(payload.state.rows)}
        for position, row in enumerate(
            sorted(rows, key=lambda row: ranks.get(str(row.id), len(ranks) + row.position))
        ):
            row.position = position
    return save(db, dorm.organization_id, f"dormitory-{dorm.id}", key, payload)


@router.get("/personnel/table-views/{key}")
def read_personnel_view(
    key: ViewKey, _user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    return response(db.get(TableView, (membership.organization_id, "personnel", key)))


@router.put("/personnel/table-views/{key}")
def save_personnel_view(
    key: ViewKey, payload: SaveView, _user: SubscribedUser, membership: Membership, db: DbSession
) -> dict[str, Any]:
    return save(db, membership.organization_id, "personnel", key, payload)
