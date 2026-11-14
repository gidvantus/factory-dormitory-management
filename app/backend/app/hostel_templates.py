"""Шаблон сохраняет настройки, а связи сопоставляет с таблицами получателя."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.hostel_rows import report_link_target, validate_report_target
from app.models.custom_tab import CustomTab
from app.models.report import ReportRow
from app.models.table_column import TableColumn
from app.schemas.hostel import HostelReportLink, HostelRow, HostelTableLink
from app.table_data import read_columns, snapshot_table, validate_link


def snapshot_rows(db: Session, dormitory_id: int, rows: list[HostelRow]) -> list[dict[str, Any]]:
    result = []
    for row in rows:
        if row.archived:
            continue
        link = row.link
        source = None
        if isinstance(link, HostelTableLink):
            source = snapshot_table(db, dormitory_id, link.table_key, link.model_dump())
        elif isinstance(link, HostelReportLink):
            target = report_link_target(db, dormitory_id, link)
            source = {"report_row": target.name, "metric": target.metric_key}
        result.append({"row": row.model_dump(), "source": source})
    return result


def match_source(
    db: Session, dormitory_id: int, link: HostelTableLink, snapshot: dict[str, Any]
) -> HostelTableLink:
    key = link.table_key
    if key.startswith("custom_"):
        parent_id = None
        names = [parent["name"] for parent in snapshot.get("parent_tabs", [])]
        for name in [*names, snapshot["tab_name"]]:
            parent = db.scalar(
                select(CustomTab).where(
                    CustomTab.dormitory_id == dormitory_id,
                    CustomTab.name == name,
                    CustomTab.parent_id == parent_id,
                    CustomTab.parent_section
                    == (snapshot.get("parent_section") if parent_id is None else None),
                    CustomTab.is_active.is_(True),
                )
            )
            if parent is None:
                raise HTTPException(422, f"Создайте вкладку «{name}» или выберите другую таблицу")
            parent_id = parent.id
        key = f"custom_{parent_id}"
    columns = [column for column in read_columns(db, dormitory_id, key) if not column.archived]
    old_columns = {column["id"]: column for column in snapshot["columns"]}

    def match(column_id: int) -> TableColumn:
        old = old_columns[column_id]
        for column in columns:
            if column.kind == old["kind"] and (
                column.builtin_key == old["builtin_key"]
                if old["builtin_key"]
                else column.name.casefold() == old["name"].casefold()
            ):
                return column
        raise HTTPException(422, f"В таблице получателя нет столбца «{old['name']}»")

    column = match(link.column_id)
    value = link.value
    if column.kind == "select" and link.operator == "equals":
        option = next(
            (item for item in old_columns[link.column_id]["options"] if item["id"] == value), None
        )
        replacement = next(
            (
                item["id"]
                for item in column.options
                if option and item["label"] == option["label"] and not item.get("archived")
            ),
            None,
        )
        if replacement is None:
            raise HTTPException(422, f"Выберите значение столбца «{column.name}» в новом общежитии")
        value = replacement
    return link.model_copy(
        update={
            "table_key": key,
            "column_id": column.id,
            "value": value,
            "date_column_id": match(link.date_column_id).id if link.date_column_id else None,
        }
    )


def template_rows(
    db: Session, dormitory_id: int, stored: list[dict[str, Any]]
) -> tuple[list[HostelRow], dict[str, str]]:
    rows = []
    warnings = {}
    for item in stored:
        row = HostelRow.model_validate(item["row"])
        link, source = row.link, item["source"]
        try:
            if isinstance(link, HostelTableLink):
                link = match_source(db, dormitory_id, link, source)
                validated = validate_link(db, dormitory_id, link)
                assert isinstance(validated, HostelTableLink)
                link = validated
            elif isinstance(link, HostelReportLink):
                match = (
                    ReportRow.metric_key == source["metric"]
                    if source["metric"]
                    else ReportRow.name == source["report_row"]
                )
                target = db.scalar(
                    select(ReportRow).where(ReportRow.dormitory_id == dormitory_id, match)
                )
                if target is None:
                    raise HTTPException(422, f"В общем отчёте нет строки «{source['report_row']}»")
                link = HostelReportLink(table_key="report", row_id=target.id)
                validate_report_target(db, dormitory_id, link)
            rows.append(row.model_copy(update={"link": link}))
        except HTTPException as exc:
            rows.append(row.model_copy(update={"link": None}))
            warnings[row.key] = str(exc.detail)
    return rows, warnings
