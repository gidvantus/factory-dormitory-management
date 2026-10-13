"""Независимая структура нового общежития из явно выбранных вкладок."""

from copy import deepcopy
from datetime import date
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.custom_tab import CustomTab
from app.models.dormitory import Dormitory
from app.models.hostel import Hostel
from app.models.report import ReportRow
from app.models.report_template import ReportTemplateRow
from app.report_defaults import DEFAULT_REPORT_FORMULA, REQUIRED_REPORT_ROW_NAMES, required_row_name
from app.schemas.table_column import report_link_adapter
from app.section_state import SECTIONS, locked_dormitory
from app.tab_catalog import TabChoice, TabVariant, catalog, normalized_name
from app.tab_tree import copy_columns
from app.table_data import columns_for, ensure_columns, get_custom_tab, snapshot_link, validate_link


def initialize_structure(
    db: Session, dorm: Dormitory, choices: list[TabChoice], template_rows: list[ReportTemplateRow]
) -> None:
    def resolve() -> list[TabVariant]:
        variants = {
            variant.id: variant
            for item in catalog(db)
            for variant in item.variants
            if variant.dormitory_id != dorm.id
        }
        if any(choice.source_id not in variants for choice in choices):
            raise HTTPException(409, "Список вкладок изменился. Обновите список и повторите выбор.")
        selected = [variants[choice.source_id] for choice in choices]
        if len({normalized_name(item.name) for item in selected}) != len(selected):
            raise HTTPException(422, "Выберите один образец для каждого названия вкладки")
        return selected

    selected = resolve()
    for identifier in sorted({item.dormitory_id for item in selected if item.dormitory_id}):
        locked_dormitory(db, identifier)
    selected = resolve()
    by_name = {normalized_name(item.name): item for item in selected}
    standards = {item.section_key: item for item in selected if item.section_key}
    dorm.section_states = {key: "active" if key in standards else "deleted" for key in SECTIONS}
    dorm.section_parents = {}
    for key, item in standards.items():
        parent = by_name.get(normalized_name(item.parent_name)) if item.parent_name else None
        dorm.section_parents[key] = (
            parent.section_key if parent and parent.kind == "standard" else None
        )
    dorm.section_parents = dict(dorm.section_parents)
    db.flush()
    targets: dict[str, str] = {}
    for item in selected:
        if item.kind != "standard" or not item.section_key:
            continue
        targets[normalized_name(item.name)] = item.section_key
        if item.section_key in ("report", "places", "movement", "payments"):
            continue
        if item.dormitory_id:
            ensure_columns(db, item.dormitory_id, item.section_key)
            copy_columns(db, item.dormitory_id, item.section_key, dorm.id, item.section_key)
        else:
            ensure_columns(db, dorm.id, item.section_key)
    pending = [item for item in selected if item.kind == "custom"]
    while pending:
        progress = False
        for item in pending[:]:
            parent_name = normalized_name(item.parent_name) if item.parent_name else None
            if parent_name in by_name and parent_name not in targets:
                continue
            assert item.tab_id is not None and item.dormitory_id is not None
            source = get_custom_tab(db, item.dormitory_id, item.tab_id)
            parent_key = targets.get(parent_name) if parent_name else None
            tab = CustomTab(
                dormitory_id=dorm.id,
                name=item.name,
                table_created=source.table_created,
                is_group=source.is_group,
                parent_id=int(parent_key.removeprefix("custom_"))
                if parent_key and parent_key.startswith("custom_")
                else None,
                parent_section=parent_key
                if parent_key and not parent_key.startswith("custom_")
                else None,
            )
            db.add(tab)
            db.flush()
            copy_columns(db, source.dormitory_id, source.table_key, dorm.id, tab.table_key)
            targets[normalized_name(item.name)] = tab.table_key
            pending.remove(item)
            progress = True
        if not progress:
            raise HTTPException(
                422,
                "Выбранные образцы образуют круг родительских вкладок. Выберите другой образец.",
            )
    # Hostels define the tables in «Размещение персонала». Their daily values are never copied.
    place_variant = standards.get("places")
    if place_variant and place_variant.dormitory_id:
        for source_hostel in db.scalars(
            select(Hostel).where(Hostel.dormitory_id == place_variant.dormitory_id)
        ):
            db.add(
                Hostel(
                    dormitory_id=dorm.id,
                    name=source_hostel.name,
                    active_from_month=source_hostel.active_from_month,
                    active_until_month=source_hostel.active_until_month,
                )
            )
    db.flush()

    def restore_rule(snapshot: dict[str, Any], row_name: str) -> dict[str, Any]:
        rule = deepcopy(snapshot["rule"])
        if rule["table_key"] == "arrival_plan":
            return rule
        source_name = (
            str(snapshot["tab_name"])
            if rule["table_key"].startswith("custom_")
            else SECTIONS[rule["table_key"]]
        )
        target_key = targets.get(normalized_name(source_name))
        if target_key is None:
            raise HTTPException(
                422, f"Для строки отчёта «{row_name}» выберите также вкладку «{source_name}»."
            )
        rule["table_key"] = target_key
        if target_key == "places":
            if rule.get("hostel_id") is not None:
                definition = snapshot["hostel"]
                hostels = list(db.scalars(select(Hostel).where(Hostel.dormitory_id == dorm.id)))
                hostel = next(
                    (
                        hostel
                        for hostel in hostels
                        if normalized_name(hostel.name) == normalized_name(definition["name"])
                    ),
                    None,
                )
                if hostel is None and place_variant and place_variant.dormitory_id is None:
                    hostel = Hostel(
                        dormitory_id=dorm.id,
                        name=definition["name"],
                        active_from_month=date.fromisoformat(definition["active_from_month"]),
                        active_until_month=date.fromisoformat(definition["active_until_month"])
                        if definition.get("active_until_month")
                        else None,
                    )
                    db.add(hostel)
                    db.flush()
                if hostel is None:
                    raise HTTPException(
                        422,
                        f"В образце «Размещение персонала» нет хостела для строки «{row_name}». "
                        "Выберите совместимый образец.",
                    )
                rule["hostel_id"] = hostel.id
            return validate_link(
                db, dorm.id, report_link_adapter.validate_python(rule)
            ).model_dump()
        original_columns = {column["id"]: column for column in snapshot["columns"]}
        columns = columns_for(db, dorm.id, target_key)

        def mapped_column(identifier: int) -> Any:
            original = original_columns[identifier]
            matches = [
                column
                for column in columns
                if not column.archived
                and column.kind == original["kind"]
                and normalized_name(column.name) == normalized_name(original["name"])
            ]
            if len(matches) != 1:
                raise HTTPException(
                    422,
                    f"Для строки «{row_name}» в выбранном образце «{source_name}» "
                    f"нужен столбец «{original['name']}» с тем же типом.",
                )
            return matches[0]

        original = original_columns[rule["column_id"]]
        target = mapped_column(rule["column_id"])
        if target.kind == "select" and rule.get("operator", "equals") == "equals":
            label = next(
                (
                    option["label"]
                    for option in original["options"]
                    if option["id"] == rule["value"]
                ),
                None,
            )
            option = next(
                (
                    option
                    for option in target.options
                    if label and normalized_name(option["label"]) == normalized_name(label)
                ),
                None,
            )
            if option is None:
                raise HTTPException(
                    422, f"В выбранном образце нет варианта списка для строки «{row_name}»."
                )
            rule["value"] = option["id"]
        rule["column_id"] = target.id
        if rule.get("date_column_id") is not None:
            rule["date_column_id"] = mapped_column(rule["date_column_id"]).id
        return validate_link(db, dorm.id, report_link_adapter.validate_python(rule)).model_dump()

    report_variant = standards.get("report")
    if template_rows and not report_variant:
        raise HTTPException(422, "Для применения шаблона выберите «Общий отчёт»")
    definitions: list[dict[str, Any]] = [
        {"name": row.name, "formula": row.formula, "snapshot": row.link_snapshot}
        for row in template_rows
    ]
    if report_variant and report_variant.dormitory_id and not template_rows:
        definitions = [
            {"name": row.name, "formula": row.formula, "snapshot": snapshot_link(db, row)}
            for row in db.scalars(
                select(ReportRow)
                .where(ReportRow.dormitory_id == report_variant.dormitory_id)
                .order_by(ReportRow.position, ReportRow.id)
            )
        ]
    aliases = {
        row["name"]: canonical
        for row in definitions
        if (canonical := required_row_name(row["name"])) and row["name"] != canonical
    }
    for definition in definitions:
        canonical = required_row_name(definition["name"])
        if canonical:
            definition["name"] = canonical
            definition["formula"] = definition["formula"] or DEFAULT_REPORT_FORMULA
            definition["snapshot"] = None
        if definition["formula"]:
            for old, new in aliases.items():
                definition["formula"] = definition["formula"].replace(f"[{old}]", f"[{new}]")
    names = {row["name"] for row in definitions}
    definitions += [
        {"name": name, "formula": DEFAULT_REPORT_FORMULA, "snapshot": None}
        for name in REQUIRED_REPORT_ROW_NAMES
        if name not in names
    ]
    for position, definition in enumerate(definitions, start=1):
        db.add(
            ReportRow(
                dormitory_id=dorm.id,
                name=definition["name"],
                position=position,
                formula=definition["formula"],
                link=restore_rule(definition["snapshot"], definition["name"])
                if definition["snapshot"]
                else None,
            )
        )
