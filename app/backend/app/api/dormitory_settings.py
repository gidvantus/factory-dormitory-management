"""Транзакционный конструктор структуры общежития."""

import hashlib
import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.custom_tabs import RESERVED_NAMES, tab_responses
from app.api.sections import metadata, section_keys
from app.api.table_columns import prepare_options
from app.db import get_db
from app.models.custom_tab import CustomTab
from app.models.report import ReportRow
from app.models.table_column import TableColumn
from app.schemas.custom_tab import CreateTabRequest
from app.schemas.table_column import ColumnRequest, ColumnResponse
from app.section_state import (
    SECTIONS,
    locked_dormitory,
    section_ancestors,
    section_parents,
    section_status,
)
from app.security import ACTIVE_USER_RESPONSES, ActiveUser
from app.tab_catalog import normalized_name
from app.tab_tree import all_tabs, delete_tabs, descendants
from app.table_data import (
    DEFAULT_COLUMNS,
    column_dependencies,
    columns_for,
    ensure_columns,
    require_writable_table,
)

router = APIRouter(
    prefix="/dormitories/{dormitory_id}/settings",
    tags=["dormitory-settings"],
    responses={**ACTIVE_USER_RESPONSES},
)
DbSession = Annotated[Session, Depends(get_db)]
EntityId = Annotated[int, Path(ge=1, le=2147483647)]


class SettingColumn(ColumnRequest):
    id: int | None = Field(default=None, ge=1)
    archived: bool = False


class TableSetting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(min_length=1, max_length=80)
    columns: list[SettingColumn]


class TabSetting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    parent_key: str | None = None
    is_active: bool = True

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        return CreateTabRequest.name_not_blank(value)


class SaveSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(min_length=64, max_length=64)
    tables: list[TableSetting] = Field(default_factory=list)
    tabs: list[TabSetting] = Field(default_factory=list)
    sections: dict[str, Literal["active", "hidden"]] = Field(default_factory=dict)
    deleted: list[str] = Field(default_factory=list)


def settings_snapshot(db: Session, dormitory_id: int) -> dict[str, Any]:
    dorm = locked_dormitory(db, dormitory_id)
    sections = metadata(db, dormitory_id)
    tabs = all_tabs(db, dormitory_id)
    tables: dict[str, list[dict[str, Any]]] = {}
    for key in DEFAULT_COLUMNS:
        if not any(
            section_status(dorm, ancestor) == "deleted" for ancestor in section_ancestors(dorm, key)
        ):
            ensure_columns(db, dormitory_id, key)
            tables[key] = []
    for tab in tabs:
        tables[tab.table_key] = []
    for key in tables:
        tables[key] = [
            {
                **ColumnResponse.model_validate(col).model_dump(),
                "used_by": column_dependencies(db, col),
            }
            for col in columns_for(db, dormitory_id, key)
        ]
    tab_data = [item.model_dump() for item in tab_responses(db, dormitory_id, tabs)]
    section_data = [item.model_dump() for item in sections]
    rules = [
        {"id": row.id, "name": row.name, "formula": row.formula, "link": row.link}
        for row in db.scalars(
            select(ReportRow)
            .where(ReportRow.dormitory_id == dormitory_id)
            .order_by(ReportRow.position, ReportRow.id)
        )
    ]
    configuration = {
        "tables": tables,
        "tabs": [
            {
                key: value
                for key, value in tab.items()
                if key not in ("has_data", "delete_block_reason")
            }
            for tab in tab_data
        ],
        "sections": [
            {
                key: value
                for key, value in section.items()
                if key not in ("has_data", "delete_block_reason")
            }
            for section in section_data
        ],
        "rules": rules,
    }
    revision = hashlib.sha256(
        json.dumps(configuration, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    return {
        "revision": revision,
        "tables": tables,
        "tabs": tab_data,
        "sections": section_data,
        "rules": rules,
    }


@router.get("")
def read_settings(dormitory_id: EntityId, _user: ActiveUser, db: DbSession) -> dict[str, Any]:
    result = settings_snapshot(db, dormitory_id)
    db.commit()
    return result


def save_table(db: Session, dormitory_id: int, key: str, payload: TableSetting) -> None:
    require_writable_table(db, dormitory_id, key)
    existing = {col.id: col for col in columns_for(db, dormitory_id, key)}
    ids = [col.id for col in payload.columns if col.id is not None]
    if len(set(ids)) != len(ids) or set(ids) != existing.keys():
        raise HTTPException(409, "Список столбцов изменился. Обновите настройки.")
    names: set[str] = set()
    for position, item in enumerate(payload.columns):
        if not item.archived:
            name = normalized_name(item.name)
            if name in names:
                raise HTTPException(409, "Названия видимых столбцов не должны повторяться")
            names.add(name)
        column = existing.get(item.id) if item.id else None
        if column:
            if item.kind != column.kind:
                raise HTTPException(
                    409, "Тип существующего столбца нельзя изменить. Создайте новый."
                )
            if item.archived and not column.archived and (used := column_dependencies(db, column)):
                raise HTTPException(
                    409, f"Столбец «{column.name}» используется в отчёте: {', '.join(used)}"
                )
            if column.builtin_key:
                if [option.model_dump() for option in item.options] != column.options:
                    raise HTTPException(409, "Варианты стандартного столбца изменять нельзя")
            else:
                column.options = prepare_options(item, column)
        else:
            if item.kind in ("action", "hostel"):
                raise HTTPException(422, "Выберите тип данных нового столбца")
            column = TableColumn(
                dormitory_id=dormitory_id, table_key=key, options=prepare_options(item, None)
            )
            db.add(column)
        column.name, column.kind, column.position, column.archived = (
            item.name,
            item.kind,
            position,
            item.archived,
        )
    if key.startswith("custom_"):
        tab = db.get(CustomTab, int(key.removeprefix("custom_")))
        assert tab is not None
        if not tab.table_created and any(not col.archived for col in payload.columns):
            tab.table_created = True
            db.add(
                TableColumn(
                    dormitory_id=dormitory_id,
                    table_key=key,
                    builtin_key="action_delete",
                    name="Удалить",
                    kind="action",
                    position=len(payload.columns),
                    options=[],
                    archived=False,
                )
            )
    db.flush()


@router.put("")
def write_settings(
    dormitory_id: EntityId, payload: SaveSettings, _user: ActiveUser, db: DbSession
) -> dict[str, Any]:
    dorm = locked_dormitory(db, dormitory_id)
    try:
        current = settings_snapshot(db, dormitory_id)
        if current["revision"] != payload.revision:
            raise HTTPException(
                409, "Структуру изменили в другом окне. Обновите настройки и повторите изменения."
            )
        if len({item.key for item in payload.tabs}) != len(payload.tabs) or len(
            {item.key for item in payload.tables}
        ) != len(payload.tables):
            raise HTTPException(422, "Вкладка указана дважды")
        tree = all_tabs(db, dormitory_id)
        by_key = {tab.table_key: tab for tab in tree}
        parents = section_parents(dorm)
        states = dict(dorm.section_states)
        # Restores happen before editing; hides happen after editing in this transaction.
        for key, state in payload.sections.items():
            if key not in SECTIONS:
                raise HTTPException(422, "Неизвестная стандартная вкладка")
            if state == "hidden" and section_status(dorm, key) == "deleted":
                raise HTTPException(409, "Сначала добавьте вкладку обратно")
            if state == "active":
                if section_status(dorm, key) == "deleted" and key in ("movement", "payments"):
                    for child in section_keys(key, parents)[1:]:
                        states.pop(child, None)
                states[key] = state
        dorm.section_states = states
        for setting in payload.tabs:
            if setting.key in by_key:
                existing_tab = by_key[setting.key]
                actual_parent = (
                    f"custom_{existing_tab.parent_id}"
                    if existing_tab.parent_id
                    else existing_tab.parent_section
                )
                if setting.parent_key != actual_parent:
                    raise HTTPException(422, "Перемещение вкладок не поддерживается")
                existing_tab.name = setting.name
                if setting.is_active:
                    existing_tab.is_active = True
        db.flush()
        pending = [item for item in payload.tabs if item.key not in by_key]
        aliases: dict[str, str] = {}
        while pending:
            progress = False
            for item in pending[:]:
                if not item.key.startswith("new_"):
                    raise HTTPException(404, "Вкладка не найдена")
                parent = aliases.get(item.parent_key or "", item.parent_key)
                if parent and parent.startswith("new_"):
                    continue
                name = CreateTabRequest.name_not_blank(item.name)
                if parent and parent not in SECTIONS and parent not in by_key:
                    raise HTTPException(422, "Родительская вкладка не найдена")
                if parent:
                    require_writable_table(db, dormitory_id, parent) if parent.startswith(
                        "custom_"
                    ) else None
                    if parent in SECTIONS:
                        from app.section_state import require_section_writable

                        require_section_writable(db, dormitory_id, parent)
                tab = CustomTab(
                    dormitory_id=dormitory_id,
                    name=name,
                    parent_id=by_key[parent].id if parent in by_key else None,
                    parent_section=parent if parent in SECTIONS else None,
                    is_active=item.is_active,
                )
                db.add(tab)
                db.flush()
                if tab.parent_id:
                    assert parent is not None
                    by_key[parent].is_group = True
                    db.flush()
                aliases[item.key] = tab.table_key
                by_key[tab.table_key] = tab
                pending.remove(item)
                progress = True
            if not progress:
                raise HTTPException(422, "Родительские вкладки образуют круг")
        for item in payload.tabs:
            tab = by_key[aliases.get(item.key, item.key)]
            tab.name = CreateTabRequest.name_not_blank(item.name)
            if item.is_active:
                tab.is_active = True
        db.flush()
        for table in payload.tables:
            key = aliases.get(table.key, table.key)
            if key not in DEFAULT_COLUMNS and key not in by_key:
                raise HTTPException(422, "Таблица не найдена")
            if key in DEFAULT_COLUMNS:
                ensure_columns(db, dormitory_id, key)
            save_table(db, dormitory_id, key, table)
        for item in payload.tabs:
            by_key[aliases.get(item.key, item.key)].is_active = item.is_active
        dorm.section_states = {**dorm.section_states, **payload.sections}
        db.flush()
        # Validate sibling names against both built-in and custom tabs.
        names: set[tuple[str | None, str]] = set()
        for key, name in SECTIONS.items():
            if section_status(dorm, key) != "deleted":
                names.add((parents.get(key), normalized_name(name)))
        for tab in by_key.values():
            parent_key = f"custom_{tab.parent_id}" if tab.parent_id else tab.parent_section
            pair = (parent_key, normalized_name(tab.name))
            if pair in names or (not parent_key and pair[1] in RESERVED_NAMES):
                raise HTTPException(409, f"Вкладка «{tab.name}» с таким названием уже есть")
            names.add(pair)
        for key in payload.deleted:
            fresh = settings_snapshot(db, dormitory_id)
            if key in SECTIONS:
                section = next(item for item in fresh["sections"] if item["key"] == key)
                if section["delete_block_reason"]:
                    raise HTTPException(409, section["delete_block_reason"])
                keys = section_keys(key, parents)
                delete_tabs(
                    db,
                    descendants(
                        all_tabs(db, dormitory_id),
                        {
                            tab.id
                            for tab in all_tabs(db, dormitory_id)
                            if tab.parent_section in keys
                        },
                    ),
                )
                for column in db.scalars(
                    select(TableColumn).where(
                        TableColumn.dormitory_id == dormitory_id, TableColumn.table_key.in_(keys)
                    )
                ):
                    db.delete(column)
                dorm.section_states = {**dorm.section_states, **dict.fromkeys(keys, "deleted")}
            elif key in by_key:
                deleted_tab = next((tab for tab in fresh["tabs"] if tab["table_key"] == key), None)
                if deleted_tab is None:
                    continue
                if deleted_tab["delete_block_reason"]:
                    raise HTTPException(409, deleted_tab["delete_block_reason"])
                delete_tabs(db, descendants(all_tabs(db, dormitory_id), {by_key[key].id}))
            else:
                raise HTTPException(404, "Удаляемая вкладка не найдена")
        db.flush()
        result = settings_snapshot(db, dormitory_id)
        db.commit()
        return result
    except (HTTPException, ValueError):
        db.rollback()
        raise
