"""Сохранение и независимое восстановление всей структуры."""

from copy import deepcopy
from datetime import date
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session

from app.custom_tab_options import mapped_options, options_for
from app.models.custom_tab import CustomTab
from app.models.dormitory import Dormitory
from app.models.dormitory_template import DormitoryTemplate
from app.models.hostel import Hostel
from app.models.report import ReportRow
from app.models.table_column import TableColumn
from app.models.user import User
from app.report_defaults import DEFAULT_REPORT_FORMULA, REQUIRED_REPORT_ROW_NAMES
from app.schemas.table_column import report_link_adapter
from app.section_state import SECTIONS, locked_dormitory, section_parents, section_status
from app.tab_tree import all_tabs
from app.table_data import DEFAULT_COLUMNS, columns_for, ensure_columns, validate_link

TEMPLATE_NOT_FOUND_DETAIL = "Шаблон не найден"


def visible_templates(organization_id: int) -> Select[DormitoryTemplate]:
    """Шаблоны, доступные организации из сессии.

    Своя библиотека — шаблоны, снятые участниками организации; шаблоны без автора
    считаются общими. Принадлежность берётся по автору, потому что колонки
    организации у `dormitory_templates` пока нет: настоящая привязка — T3, здесь
    закрывается чтение и удаление чужой структуры между организациями.
    """
    authors = select(User.id).where(User.active_organization_id == organization_id)
    return select(DormitoryTemplate).where(
        or_(
            DormitoryTemplate.created_by_id.is_(None),
            DormitoryTemplate.created_by_id.in_(authors),
        )
    )


def own_template(db: Session, template_id: int, organization_id: int) -> DormitoryTemplate:
    """Шаблон из библиотеки организации. Чужой и несуществующий неразличимы: `404`."""
    template = db.scalar(
        visible_templates(organization_id).where(DormitoryTemplate.id == template_id)
    )
    if template is None:
        raise HTTPException(404, TEMPLATE_NOT_FOUND_DETAIL)
    return template


def take_snapshot(db: Session, dormitory_id: int) -> dict[str, Any]:
    dorm = locked_dormitory(db, dormitory_id)
    tabs = all_tabs(db, dormitory_id)
    for key in DEFAULT_COLUMNS:
        if section_status(dorm, key) != "deleted":
            ensure_columns(db, dormitory_id, key)
    keys = list(DEFAULT_COLUMNS) + [tab.table_key for tab in tabs]
    return {
        "version": 1,
        "sections": {key: section_status(dorm, key) for key in SECTIONS},
        "parents": section_parents(dorm),
        "tabs": [
            {
                "key": tab.table_key,
                "options": options_for(tab).model_dump(),
                "name": tab.name,
                "is_active": tab.is_active,
                "table_created": tab.table_created,
                "is_group": tab.is_group,
                "parent": f"custom_{tab.parent_id}" if tab.parent_id else tab.parent_section,
            }
            for tab in tabs
        ],
        "columns": {
            key: [
                {
                    "id": col.id,
                    "name": col.name,
                    "kind": col.kind,
                    "position": col.position,
                    "builtin_key": col.builtin_key,
                    "options": deepcopy(col.options),
                    "archived": col.archived,
                }
                for col in columns_for(db, dormitory_id, key)
            ]
            for key in keys
        },
        "hostels": [
            {
                "id": hostel.id,
                "name": hostel.name,
                "active_from_month": hostel.active_from_month.isoformat(),
                "active_until_month": hostel.active_until_month.isoformat()
                if hostel.active_until_month
                else None,
            }
            for hostel in db.scalars(select(Hostel).where(Hostel.dormitory_id == dormitory_id))
        ],
        "rows": [
            {
                "name": row.name,
                "position": row.position,
                "formula": row.formula,
                "link": deepcopy(row.link),
            }
            for row in db.scalars(
                select(ReportRow)
                .where(ReportRow.dormitory_id == dormitory_id)
                .order_by(ReportRow.position, ReportRow.id)
            )
        ],
    }


def apply_snapshot(
    db: Session, dorm: Dormitory, snapshot: dict[str, Any], selected_keys: list[str] | None = None
) -> None:
    data = deepcopy(snapshot)
    available = {key for key, state in data["sections"].items() if state != "deleted"} | {
        item["key"] for item in data["tabs"]
    }
    chosen = set(selected_keys) if selected_keys is not None else available
    if not chosen <= available:
        raise HTTPException(422, "В шаблоне нет выбранной вкладки")
    data["sections"] = {
        key: state if key in chosen else "deleted" for key, state in data["sections"].items()
    }
    data["parents"] = {
        key: parent if parent in chosen else None for key, parent in data["parents"].items()
    }
    data["tabs"] = [item for item in data["tabs"] if item["key"] in chosen]
    for item in data["tabs"]:
        if item["parent"] not in chosen:
            item["parent"] = None
    data["columns"] = {
        key: definitions for key, definitions in data["columns"].items() if key in chosen
    }
    if "places" not in chosen:
        data["hostels"] = []
    if "report" not in chosen:
        data["rows"] = [
            {"name": name, "position": i, "formula": DEFAULT_REPORT_FORMULA, "link": None}
            for i, name in enumerate(REQUIRED_REPORT_ROW_NAMES, 1)
        ]
    for row in data["rows"]:
        if (
            row["link"]
            and row["link"]["table_key"] != "arrival_plan"
            and row["link"]["table_key"] not in chosen
        ):
            raise HTTPException(
                422, f"Для строки «{row['name']}» выберите также вкладку-источник её связи."
            )
    # Enable during construction, then restore hidden states. No record data is copied.
    dorm.section_states = {
        key: "active" if state != "deleted" else "deleted"
        for key, state in data["sections"].items()
    }
    dorm.section_parents = data["parents"]
    tables: dict[str, str] = {}
    created: list[tuple[CustomTab, bool]] = []
    pending = list(data["tabs"])
    while pending:
        for item in pending[:]:
            parent = item["parent"]
            if parent and parent.startswith("custom_") and parent not in tables:
                continue
            tab = CustomTab(
                dormitory_id=dorm.id,
                name=item["name"],
                table_created=item["table_created"],
                is_group=item["is_group"],
                is_active=True,
                options=item.get("options", {}),
                parent_id=int(tables[parent].removeprefix("custom_"))
                if parent and parent.startswith("custom_")
                else None,
                parent_section=parent if parent and not parent.startswith("custom_") else None,
            )
            db.add(tab)
            db.flush()
            tables[item["key"]] = tab.table_key
            created.append((tab, item["is_active"]))
            pending.remove(item)
    columns: dict[int, int] = {}
    options: dict[tuple[int, str], str] = {}
    for key, definitions in data["columns"].items():
        for definition in definitions:
            original_id = definition.pop("id")
            for option in definition["options"]:
                old = option["id"]
                if not definition["builtin_key"]:
                    option["id"] = str(uuid4())
                options[(original_id, old)] = option["id"]
            col = TableColumn(dormitory_id=dorm.id, table_key=tables.get(key, key), **definition)
            db.add(col)
            db.flush()
            columns[original_id] = col.id
    for tab, _ in created:
        tab.options = mapped_options(tab, columns)
    hostels: dict[int, int] = {}
    for item in data["hostels"]:
        original_id = item.pop("id")
        item["active_from_month"] = date.fromisoformat(item["active_from_month"])
        if item["active_until_month"]:
            item["active_until_month"] = date.fromisoformat(item["active_until_month"])
        hostel = Hostel(dormitory_id=dorm.id, **item)
        db.add(hostel)
        db.flush()
        hostels[original_id] = hostel.id
    for definition in data["rows"]:
        rule = definition["link"]
        if rule:
            rule["table_key"] = tables.get(rule["table_key"], rule["table_key"])
            if rule["table_key"] == "places":
                if rule.get("hostel_id"):
                    rule["hostel_id"] = hostels[rule["hostel_id"]]
            elif rule["table_key"] != "arrival_plan":
                original_id = rule["column_id"]
                if (original_id, rule.get("value")) in options:
                    rule["value"] = options[(original_id, rule["value"])]
                rule["column_id"] = columns[original_id]
                if rule.get("date_column_id"):
                    rule["date_column_id"] = columns[rule["date_column_id"]]
            definition["link"] = validate_link(
                db, dorm.id, report_link_adapter.validate_python(rule)
            ).model_dump()
        db.add(ReportRow(dormitory_id=dorm.id, **definition))
    dorm.section_states = data["sections"]
    for tab, active in created:
        tab.is_active = active
    db.flush()
