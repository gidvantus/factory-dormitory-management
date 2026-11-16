"""Оформление при изменении и копировании структуры рабочих таблиц."""

from typing import Literal, TypedDict

from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.table_view import TableView


class TableColors(TypedDict, total=False):
    row_colors: dict[str, str]
    column_colors: dict[str, str]


def table_colors(db: Session, dormitory: Dormitory, key: str) -> TableColors:
    view = db.get(TableView, (dormitory.organization_id, f"dormitory-{dormitory.id}", key))
    return (
        TableColors(
            row_colors=dict(view.state.get("row_colors", {})),
            column_colors=dict(view.state.get("column_colors", {})),
        )
        if view
        else {}
    )


def remap_colors(colors: dict[str, str], identifiers: dict[int, int]) -> dict[str, str]:
    return {str(new): colors[str(old)] for old, new in identifiers.items() if str(old) in colors}


def restore_table_colors(
    db: Session,
    dormitory: Dormitory,
    key: str,
    colors: TableColors,
    *,
    row_ids: dict[int, int] | None = None,
    column_ids: dict[int, int] | None = None,
) -> None:
    rows = colors.get("row_colors", {})
    columns = colors.get("column_colors", {})
    if row_ids is not None:
        rows = remap_colors(rows, row_ids)
    if column_ids is not None:
        columns = remap_colors(columns, column_ids)
    if not rows and not columns:
        return

    scope = f"dormitory-{dormitory.id}"
    view = db.get(TableView, (dormitory.organization_id, scope, key))
    if view is None:
        view = TableView(
            organization_id=dormitory.organization_id,
            scope=scope,
            table_key=key,
            revision=1,
            state={"rows": [], "columns": [], "row_colors": rows, "column_colors": columns},
        )
        db.add(view)
        db.flush()
    else:
        view.state = {
            **view.state,
            "row_colors": {**view.state.get("row_colors", {}), **rows},
            "column_colors": {**view.state.get("column_colors", {}), **columns},
        }
        view.revision += 1


def clear_view_order(
    db: Session, organization_id: int, scope: str, key: str, axis: Literal["rows", "columns"]
) -> None:
    view = db.get(TableView, (organization_id, scope, key))
    if view and view.state.get(axis):
        view.state = {**view.state, axis: []}
        view.revision += 1
