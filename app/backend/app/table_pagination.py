"""Страницы рабочих таблиц после применения периода, поиска и порядка."""

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.cell_fill import FillResolver
from app.models.custom_tab import CustomTabEntry
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel
from app.models.table_column import TableColumn
from app.models.table_view import TableView
from app.table_data import Record, columns_for, get_column, record_value

PAGE_SIZE = 100
SortValue = tuple[int, Decimal | tuple[Decimal | str, ...]]


class TablePage[Response: BaseModel](BaseModel):
    rows: list[Response]
    total: int
    page: int


@dataclass
class PageRequest:
    page: Annotated[int | None, Query(ge=1)] = None
    q: Annotated[str, Query(max_length=255)] = ""
    sort_column: Annotated[
        str | None,
        Query(pattern=r"^(?:name|[1-9][0-9]{0,9}|[0-9]{4}-[0-9]{2}-[0-9]{2})$"),
    ] = None
    direction: Literal["ascending", "descending"] = "ascending"


Paging = Annotated[PageRequest, Depends()]


@dataclass
class PageSlice[Item]:
    rows: list[Item]
    total: int
    page: int

    def response[Response: BaseModel](
        self, render: Callable[[Item], Response]
    ) -> TablePage[Response]:
        return TablePage(rows=[render(row) for row in self.rows], total=self.total, page=self.page)


def sorted_value(value: Any) -> SortValue | None:
    if value is None or value in ("", "—"):
        return None
    if isinstance(value, bool):
        return (0, Decimal(int(value)))
    text = str(value).strip()
    if not text:
        return None
    number = "".join(text.split()).replace(",", ".")
    if re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?", number):
        return (0, Decimal(number))
    return (
        1,
        tuple(
            Decimal(part) if index % 2 else part
            for index, part in enumerate(re.split(r"([0-9]+)", text.casefold().replace("ё", "е")))
        ),
    )


def saved_ranks(db: Session, dormitory: Dormitory, table_key: str) -> dict[str, int]:
    view = db.get(TableView, (dormitory.organization_id, f"dormitory-{dormitory.id}", table_key))
    return {key: index for index, key in enumerate(view.state.get("rows", []))} if view else {}


def page_number(requested: int | None, total: int, size: int = PAGE_SIZE) -> int:
    return min(requested or 1, max(1, (total + size - 1) // size))


def page_items[Item](
    rows: Iterable[Item],
    paging: PageRequest,
    *,
    ranks: dict[str, int],
    row_key: Callable[[Item], str],
    search: Callable[[Item], Iterable[Any]],
    order: Callable[[Item], Any] | None = None,
    size: int = PAGE_SIZE,
) -> PageSlice[Item]:
    words = paging.q.casefold().replace("ё", "е").split()
    ordered = []
    for row in rows:
        if words:
            values = [
                str(value).casefold().replace("ё", "е")
                for value in search(row)
                if value is not None
            ]
            if not all(any(word in value for value in values) for word in words):
                continue
        ordered.append(row)
    if ranks:
        ordered.sort(key=lambda row: ranks.get(row_key(row), len(ranks)))
    if order:
        keyed = [(sorted_value(order(row)), row) for row in ordered]
        present = [(value, row) for value, row in keyed if value is not None]
        present.sort(key=lambda pair: pair[0], reverse=paging.direction == "descending")
        ordered = [row for _, row in present] + [row for value, row in keyed if value is None]
    total = len(ordered)
    page = page_number(paging.page, total, size)
    offset = (page - 1) * size
    return PageSlice(ordered[offset : offset + size], total, page)


def record_search(row: Record) -> Iterable[Any]:
    return (
        getattr(row, "full_name", None),
        getattr(row, "personnel_number", None),
        getattr(row, "phone", None),
        *row.custom_values.values(),
    )


def display_reader(
    db: Session, column: TableColumn, resolver: FillResolver | None
) -> Callable[[Record], Any]:
    labels = {item["id"]: item["label"] for item in column.options}
    if column.kind == "hostel":
        labels = {
            item.id: item.name
            for item in db.scalars(select(Hostel).where(Hostel.dormitory_id == column.dormitory_id))
        }

    def display(row: Record) -> Any:
        try:
            value = record_value(row, column, resolver)
        except HTTPException:
            if not column.fill:
                raise
            # Ошибка связанной ячейки остаётся видимой в строке, но её значение пустое.
            return None
        return labels.get(value, value) if column.kind in {"select", "hostel"} else value

    return display


def record_page[Row: Record](
    db: Session,
    dormitory: Dormitory,
    table_key: str,
    query: Select[Row],
    paging: PageRequest,
    *,
    search: Callable[[Row], Iterable[Any]] | None = None,
    predicate: Callable[[Row], bool] | None = None,
    resolver: FillResolver | None = None,
) -> PageSlice[Row]:
    ranks = saved_ranks(db, dormitory, table_key)
    if not (paging.q.strip() or paging.sort_column or ranks or predicate):
        total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0
        page = page_number(paging.page, total)
        selected = list(db.scalars(query.offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)))
        return PageSlice(selected, total, page)

    order: Callable[[Row], Any] | None = None
    if paging.sort_column:
        key = paging.sort_column
        if "-" in key and table_key.startswith("custom_"):

            def calendar_value(row: Row) -> Any:
                return row.calendar_values.get(key) if isinstance(row, CustomTabEntry) else None

            order = calendar_value
        else:
            if not key.isdecimal() or int(key) > 2147483647:
                raise HTTPException(422, "Этот столбец недоступен для сортировки")
            column = get_column(db, dormitory.id, table_key, int(key))
            if column.archived or column.kind == "action":
                raise HTTPException(422, "Этот столбец недоступен для сортировки")
            order = display_reader(db, column, resolver)
    if search is None and paging.q.strip():
        readers = [
            display_reader(db, column, resolver)
            for column in columns_for(db, dormitory.id, table_key)
            if not column.archived and column.kind != "action"
        ]
        if readers:

            def searchable(row: Row) -> Iterable[Any]:
                return (reader(row) for reader in readers)

            search = searchable
    rows = (row for row in db.scalars(query) if predicate is None or predicate(row))
    return page_items(
        rows,
        paging,
        ranks=ranks,
        row_key=lambda row: str(row.id),
        search=search or record_search,
        order=order,
    )
