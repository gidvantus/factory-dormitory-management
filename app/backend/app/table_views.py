"""Синхронизация порядка при изменении структуры через конструктор."""

from typing import Literal

from sqlalchemy.orm import Session

from app.models.table_view import TableView


def clear_view_order(
    db: Session, organization_id: int, scope: str, key: str, axis: Literal["rows", "columns"]
) -> None:
    view = db.get(TableView, (organization_id, scope, key))
    if view and view.state.get(axis):
        view.state = {**view.state, axis: []}
        view.revision += 1
