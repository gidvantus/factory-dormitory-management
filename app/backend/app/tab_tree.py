"""Операции со всей иерархией пользовательских вкладок, без фильтрации записей."""

from copy import deepcopy
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTab
from app.models.table_column import TableColumn


def all_tabs(db: Session, dormitory_id: int) -> list[CustomTab]:
    return list(
        db.scalars(
            select(CustomTab).where(CustomTab.dormitory_id == dormitory_id).order_by(CustomTab.id)
        )
    )


def descendants(tabs: list[CustomTab], roots: set[int]) -> list[CustomTab]:
    ids = set(roots)
    while new := {tab.id for tab in tabs if tab.parent_id in ids} - ids:
        ids.update(new)
    return [tab for tab in tabs if tab.id in ids]


def delete_tabs(db: Session, tabs: list[CustomTab]) -> None:
    if not tabs:
        return
    db.execute(
        delete(TableColumn).where(
            TableColumn.dormitory_id == tabs[0].dormitory_id,
            TableColumn.table_key.in_([tab.table_key for tab in tabs]),
        )
    )
    # Child IDs follow their parents. Explicit removal works with SQLite too.
    for tab in sorted(tabs, key=lambda item: item.id, reverse=True):
        db.delete(tab)
        db.flush()


def copy_columns(
    db: Session, source_dormitory: int, source_key: str, target_dormitory: int, target_key: str
) -> dict[int, int]:
    columns = list(
        db.scalars(
            select(TableColumn)
            .where(
                TableColumn.dormitory_id == source_dormitory, TableColumn.table_key == source_key
            )
            .order_by(TableColumn.position, TableColumn.id)
        )
    )
    mapping: dict[int, int] = {}
    for column in columns:
        copied = TableColumn(
            dormitory_id=target_dormitory,
            table_key=target_key,
            builtin_key=column.builtin_key,
            name=column.name,
            kind=column.kind,
            position=column.position,
            options=[
                {**deepcopy(option), "id": str(uuid4())}
                if not column.builtin_key
                else deepcopy(option)
                for option in column.options
            ],
            archived=column.archived,
        )
        db.add(copied)
        db.flush()
        mapping[column.id] = copied.id
    return mapping
