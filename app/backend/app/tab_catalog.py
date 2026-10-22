"""Общий каталог названий и вариантов структуры из разных общежитий."""

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.dormitory import Dormitory
from app.section_state import SECTIONS, section_ancestors, section_parents, section_status
from app.tab_tree import all_tabs


def normalized_name(name: str) -> str:
    return " ".join(name.split()).casefold().replace("ё", "е")


class TabChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_id: str = Field(min_length=1, max_length=100)


class TabVariant(BaseModel):
    id: str
    name: str
    kind: str
    section_key: str | None = None
    tab_id: int | None = None
    dormitory_id: int | None = None
    dormitory_name: str
    client_name: str
    parent_name: str | None = None
    path: list[str]


class CatalogItem(BaseModel):
    id: str
    name: str
    variants: list[TabVariant]


def catalog(db: Session, organization_id: int | None = None) -> list[CatalogItem]:
    """Каталог вариантов структуры; с `organization_id` — только своей организации.

    Без организации остаётся только стандартная структура: чужие общежития в
    каталог не попадают.
    """
    variants = [
        TabVariant(
            id=f"standard:0:{key}",
            name=name,
            kind="standard",
            section_key=key,
            dormitory_name="Стандартная структура",
            client_name="",
            parent_name=SECTIONS[parent]
            if (
                parent := {
                    "inflow": "movement",
                    "outflow": "movement",
                    "advance": "payments",
                    "settlement": "payments",
                }.get(key)
            )
            else None,
            path=[name],
        )
        for key, name in SECTIONS.items()
    ]
    query = select(Dormitory).order_by(Dormitory.name, Dormitory.id)
    if organization_id is not None:
        query = query.where(Dormitory.organization_id == organization_id)
    for dorm in db.scalars(query):
        parents = section_parents(dorm)
        for key, name in SECTIONS.items():
            if section_status(dorm, key) == "deleted":
                continue
            variants.append(
                TabVariant(
                    id=f"standard:{dorm.id}:{key}",
                    name=name,
                    kind="standard",
                    section_key=key,
                    dormitory_id=dorm.id,
                    dormitory_name=dorm.name,
                    client_name=dorm.client_name,
                    parent_name=SECTIONS[parent] if (parent := parents.get(key)) else None,
                    path=[SECTIONS[part] for part in reversed(section_ancestors(dorm, key))],
                )
            )
        tree = all_tabs(db, dorm.id)
        by_id = {tab.id: tab for tab in tree}
        for tab in tree:
            chain = [tab]
            while chain[-1].parent_id in by_id:
                chain.append(by_id[chain[-1].parent_id])
            section = chain[-1].parent_section
            path = (
                [SECTIONS[key] for key in reversed(section_ancestors(dorm, section))]
                if section
                else []
            ) + [part.name for part in reversed(chain)]
            variants.append(
                TabVariant(
                    id=f"custom:{tab.id}",
                    name=tab.name,
                    kind="custom",
                    tab_id=tab.id,
                    dormitory_id=dorm.id,
                    dormitory_name=dorm.name,
                    client_name=dorm.client_name,
                    parent_name=path[-2] if len(path) > 1 else None,
                    path=path,
                )
            )
    items: dict[str, CatalogItem] = {}
    for variant in variants:
        key = normalized_name(variant.name)
        if key not in items:
            items[key] = CatalogItem(id=key, name=variant.name, variants=[])
        items[key].variants.append(variant)
    return list(items.values())
