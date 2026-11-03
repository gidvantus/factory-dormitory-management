"""Защита внешних источников, используемых подвкладками персонала."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.models.organization import Organization
from app.models.personnel_builder import PersonnelBuilder


def builder_dependencies(
    db: Session,
    dormitory_id: int,
    source_ids: set[str],
    field: str | None = None,
    row_id: str | None = None,
) -> list[str]:
    dorm = db.get(Dormitory, dormitory_id)
    if dorm is None:
        return []
    # Та же блокировка, что при сохранении конструктора, закрывает гонку с удалением источника.
    db.scalar(select(Organization).where(Organization.id == dorm.organization_id).with_for_update())
    config = db.scalar(
        select(PersonnelBuilder)
        .where(PersonnelBuilder.organization_id == dorm.organization_id)
        .execution_options(populate_existing=True)
    )
    result = []
    for tab in config.state.get("tabs", []) if config else []:
        if tab.get("archived") or tab.get("isGroup") or tab.get("kind") != "table":
            continue
        for item in [
            *(c for c in tab.get("columns", []) if not c.get("archived")),
            *tab.get("rows", []),
        ]:
            rule = item.get("rule") or {}
            link = rule.get("link") or {}
            if rule.get("mode") != "link" or link.get("sourceId") not in source_ids:
                continue
            fields = [
                *([link.get("valueField")] if link.get("operation") != "count" else []),
                link.get("dateField"),
                (link.get("match") or {}).get("sourceField"),
                *(f.get("field") for f in link.get("filters", [])),
            ]
            if (field is not None and field not in fields) or (
                row_id is not None and link.get("sourceRowId") != row_id
            ):
                continue
            result.append(f"Персонал: {tab['name']} → {item.get('name') or 'строка'}")
    return result
